/**
 * Keeps a live World for the local Docker engine by polling at different cadences and
 * merging the results (runs in the browser; the caller drives `tick()`):
 *
 *   every tick (5 s)   container list + statuses
 *   every 2nd tick     container stats (CPU / memory / network)
 *   every 120th tick   host resources
 *
 * Docker has no deployments or build logs, so the deployment collection stays empty.
 * Every refresh ends in `commit()`, which diffs the new World against the last one and
 * publishes only what changed.
 */
import { netRate, type NetSample } from '../dokploy/collector';
import { diffWorld } from '../diff';
import type { Alert, Service, SourceStatus, World } from '../types';
import {
  UpstreamError,
  fetchContainers,
  fetchInfo,
  fetchLogs,
  fetchStats,
  normalize,
  type Container,
  type ContainerStat,
  type HostInfo,
  type Transport,
} from './api';

const HIST = 30;
const HOUR = 3_600_000;
/** How far back a network rate may look for a counter change (see netRate). */
const NET_WINDOW_MS = 5 * 60_000;

interface Metric {
  cpu: number;
  memMb: number;
  memLimitMb: number;
  rxBps: number;
  txBps: number;
  hist: number[];
}

export type Publish = (event: 'patch' | 'status', data: unknown) => void;

const milli = (v: number) => Math.round(v * 1000) / 1000;

export class DockerCollector {
  world: World | null = null;
  status: SourceStatus = { state: 'connecting' };

  private containers: Container[] = [];
  private host: HostInfo | undefined;
  private metrics = new Map<string, Metric>();
  private netHistory = new Map<string, NetSample[]>();
  private errorSince = new Map<string, number>();
  private resolved = new Map<string, Alert>();
  private inflight = new Map<string, Promise<void>>();
  private warned = new Set<string>();
  private ticks = 0;

  constructor(
    private readonly t: Transport,
    private readonly publish: Publish,
  ) {}

  /** First snapshot as fast as possible (containers + host), stats follow. */
  bootstrap() {
    return this.once('bootstrap', async () => {
      await Promise.allSettled([this.refreshContainers(), this.refreshHost()]);
      this.commit();
      await this.refreshStats();
      this.commit();
    });
  }

  tick() {
    return this.once('tick', async () => {
      const n = ++this.ticks;
      const jobs: Promise<unknown>[] = [this.refreshContainers()];
      if (n % 2 === 0) jobs.push(this.refreshStats());
      if (n % 120 === 0) jobs.push(this.refreshHost());
      await Promise.allSettled(jobs);
      this.commit();
    });
  }

  logsFor(containerId: string, tail: number) {
    return fetchLogs(this.t, containerId, tail);
  }

  // ---- refreshers --------------------------------------------------------------------

  private async refreshContainers() {
    try {
      this.containers = await fetchContainers(this.t);
      this.setStatus({ state: 'live', syncedAt: Date.now() });
    } catch (e) {
      const message = e instanceof UpstreamError ? e.message : `Unexpected error: ${(e as Error).message}`;
      this.setStatus({ state: 'error', message, syncedAt: this.status.syncedAt });
    }
  }

  private async refreshStats() {
    let stats: ContainerStat[];
    try {
      stats = await fetchStats(this.t);
    } catch (e) {
      return this.warn('stats', e);
    }
    const now = Date.now();
    const next = new Map<string, Metric>();
    for (const s of stats) {
      next.set(s.id, this.measure(s, now));
    }
    // Containers that are no longer running lose their metrics (their nodes show 0).
    this.metrics = next;
  }

  /** Metric (and network history) for one container from this sample. */
  private measure(s: ContainerStat, now: number): Metric {
    const prev = this.metrics.get(s.id);
    const history = (this.netHistory.get(s.id) ?? []).filter((x) => now - x.at <= NET_WINDOW_MS);
    const sample: NetSample = { at: now, rx: s.rx, tx: s.tx };
    const metric: Metric = {
      cpu: milli(s.cpu),
      memMb: Math.round(s.memMb),
      memLimitMb: Math.round(s.memLimitMb),
      rxBps: Math.round(netRate(history, sample, 'rx')),
      txBps: Math.round(netRate(history, sample, 'tx')),
      hist: [...(prev?.hist ?? []).slice(-(HIST - 1)), milli(s.cpu)],
    };
    this.netHistory.set(s.id, [...history, sample]);
    return metric;
  }

  private async refreshHost() {
    try {
      this.host = await fetchInfo(this.t);
    } catch (e) {
      this.warn('host', e);
    }
  }

  // ---- composition -------------------------------------------------------------------

  private commit() {
    const next = this.compose();
    const patch = diffWorld(this.world, next);
    this.world = next;
    if (patch) this.publish('patch', patch);
  }

  private compose(): World {
    const structure = normalize(this.containers, this.host);
    const services: Service[] = structure.services.map((svc) => {
      const m = this.metrics.get(svc.id);
      return {
        ...svc,
        cpu: m?.cpu ?? 0,
        memMb: m?.memMb ?? 0,
        memLimitMb: m?.memLimitMb ?? 0,
        cpuHist: m?.hist ?? [],
        net: m ? { rxBps: m.rxBps, txBps: m.txBps } : undefined,
        containers: 1,
      };
    });

    return {
      servers: structure.servers,
      projects: structure.projects,
      environments: structure.environments,
      services,
      deployments: [],
      alerts: this.alerts(services),
    };
  }

  /** Docker has no alerts of its own: a container in error state is the one signal. */
  private alerts(services: Service[]): Alert[] {
    const now = Date.now();
    const out: Alert[] = [];
    for (const svc of services) {
      const id = `node-error:${svc.id}`;
      if (svc.status === 'error') {
        if (!this.errorSince.has(id)) this.errorSince.set(id, now);
        this.resolved.delete(id);
        out.push({
          id,
          serviceId: svc.id,
          severity: 'critical',
          title: 'Container in error state',
          message: `${svc.name} is ${svc.description ?? 'unhealthy'}`,
          createdAt: this.errorSince.get(id)!,
        });
      } else if (this.errorSince.has(id)) {
        this.resolved.set(id, {
          id,
          serviceId: svc.id,
          severity: 'critical',
          title: 'Container in error state',
          message: `${svc.name} recovered`,
          createdAt: this.errorSince.get(id)!,
          resolvedAt: now,
        });
        this.errorSince.delete(id);
      }
    }
    for (const [id, a] of this.resolved) {
      if (now - a.resolvedAt! > 24 * HOUR) this.resolved.delete(id);
      else out.push(a);
    }
    return out;
  }

  // ---- plumbing ----------------------------------------------------------------------

  private setStatus(next: SourceStatus) {
    this.status = next;
    this.publish('status', next);
  }

  private warn(key: string, e: unknown) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[3dokploy] ${key}: ${(e as Error).message}`);
  }

  private once(key: string, fn: () => Promise<void>) {
    let p = this.inflight.get(key);
    if (!p) {
      p = fn().finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }
}
