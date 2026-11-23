/**
 * Docker backend client: talks to this app's own server (/api/docker/...), which forwards
 * to the read-only Go proxy in proxy/. Runs in the browser.
 *
 * What Docker gives us and what it doesn't:
 *   containers + labels            → projects (compose project), services (one per container)
 *   state / health                 → service status
 *   stats (cpu, memory, network)   → live metrics
 *   image name                     → source
 *   no deployments, no builds      → the deployment pipeline stays empty
 */
import { PALETTE } from '../dokploy/api';
import type { ContainerAction, Environment, Project, Server, Service, ServiceKind, ServiceStatus } from '../types';

/** Performs one GET against this app's server (`path` starts with /api/...). */
export type Transport = (path: string, timeoutMs?: number) => Promise<unknown>;

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface Container {
  id: string;
  name: string;
  image: string;
  /** docker state: running, exited, restarting, paused, created, dead */
  state: string;
  /** docker status text, e.g. "Up 9 hours (healthy)" */
  status?: string;
  /** healthy / unhealthy / starting, when the container has a health check */
  health?: string;
  labels: Record<string, string>;
}

export interface ContainerStat {
  id: string;
  name: string;
  /** fraction of one core */
  cpu: number;
  memMb: number;
  memLimitMb: number;
  /** cumulative bytes */
  rx: number;
  tx: number;
}

export interface HostInfo {
  name: string;
  cpus: number;
  memTotal: number;
  version: string;
}

/** Same-origin transport. JSON by default, plain text for container logs. */
export function serverTransport(): Transport {
  return async (path, timeoutMs = 10_000) => {
    let res: Response;
    try {
      res = await fetch(path, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new UpstreamError(`Can't reach the 3Dokploy server (${(e as Error).message})`);
    }
    if (res.ok) {
      const type = res.headers.get('content-type') ?? '';
      return type.includes('text/plain') ? res.text() : res.json();
    }
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new UpstreamError(body?.error ?? `Docker proxy ${path.split('?')[0]} → ${res.status}`, res.status);
  };
}

const get = async <T,>(t: Transport, path: string, timeoutMs?: number) => (await t(path, timeoutMs)) as T;

export const fetchVersion = (t: Transport) => get<{ version: string; apiVersion: string }>(t, '/api/docker/version', 10_000);
export const fetchInfo = (t: Transport) => get<HostInfo>(t, '/api/docker/info', 10_000);
export const fetchContainers = (t: Transport) => get<Container[]>(t, '/api/docker/containers', 20_000);
/** The proxy reads two stream samples per container, so this can take a few seconds. */
export const fetchStats = (t: Transport) => get<ContainerStat[]>(t, '/api/docker/stats', 35_000);

/** POSTs a control action. Only reachable when the server runs with control enabled. */
export async function containerAction(containerId: string, action: ContainerAction): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/docker/containers/${encodeURIComponent(containerId)}/${action}`, {
      method: 'POST',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(40_000),
    });
  } catch (e) {
    throw new UpstreamError(`Can't reach the 3Dokploy server (${(e as Error).message})`);
  }
  if (res.ok) return;
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  throw new UpstreamError(body?.error ?? `${action} failed (${res.status})`, res.status);
}

export async function fetchLogs(t: Transport, containerId: string, tail = 200): Promise<string[]> {
  const text = await get<string>(t, `/api/docker/containers/${encodeURIComponent(containerId)}/logs?tail=${tail}`, 20_000);
  return text
    .split('\n')
    .map((l) => l.replace(/\r/g, '').trimEnd())
    .filter((l) => l.trim());
}

// ---- structure -----------------------------------------------------------------------------

export interface Structure {
  servers: Server[];
  projects: Project[];
  environments: Environment[];
  services: Service[];
}

export const LOCAL_SERVER: Server = { id: 'local', name: 'docker (local)' };

const COMPOSE_PROJECT = 'com.docker.compose.project';
const COMPOSE_ONEOFF = 'com.docker.compose.oneoff';
const STANDALONE = 'standalone';

/** One-shot jobs from `docker compose run` are not part of the floor. */
const visible = (c: Container) => c.labels?.[COMPOSE_ONEOFF] !== 'True';

const projectOf = (c: Container) => c.labels?.[COMPOSE_PROJECT]?.trim() || STANDALONE;

export function statusOf(c: Container): ServiceStatus {
  if (c.state === 'restarting' || c.state === 'dead') return 'error';
  // Docker keeps the last health result on stopped containers; only a running one can be unhealthy.
  if (c.state === 'running') return c.health === 'unhealthy' ? 'error' : 'running';
  // "Exited (0) 2 minutes ago" is a clean stop; any other code is a failure.
  const exit = /Exited \((\d+)\)/.exec(c.status ?? '');
  if (exit && Number(exit[1]) !== 0) return 'error';
  return 'idle';
}

/** Containers → projects (compose projects) → one service per container. */
export function normalize(containers: Container[], host?: HostInfo): Structure {
  const list = containers.filter(visible);
  const projectIds = [...new Set(list.map(projectOf))].sort();
  const colors = new Map(projectIds.map((id, i) => [id, PALETTE[i % PALETTE.length]]));

  const projects = new Map<string, Project>();
  const environments = new Map<string, Environment>();
  const services: Service[] = [];

  for (const c of list) {
    const projectId = projectOf(c);
    if (!projects.has(projectId)) {
      projects.set(projectId, {
        id: projectId,
        name: projectId === STANDALONE ? 'standalone' : projectId,
        color: colors.get(projectId)!,
      });
    }
    const environmentId = `${projectId}:default`;
    if (!environments.has(environmentId)) {
      environments.set(environmentId, { id: environmentId, projectId, name: 'production' });
    }

    const kind: ServiceKind = c.labels?.[COMPOSE_PROJECT] ? 'compose' : 'app';
    services.push({
      id: c.id,
      projectId,
      environmentId,
      serverId: LOCAL_SERVER.id,
      name: c.name,
      kind,
      status: statusOf(c),
      cpu: 0,
      memMb: 0,
      memLimitMb: 0,
      source: c.image || undefined,
      appName: c.name,
      description: c.status,
      replicas: 1,
      lastDeploy: null,
      cpuHist: [],
      containers: 1,
    });
  }

  const servers: Server[] = [
    {
      ...LOCAL_SERVER,
      name: host?.name ?? LOCAL_SERVER.name,
      vcpu: host?.cpus,
      ramGb: host?.memTotal ? Math.round((host.memTotal / 1024 ** 3) * 10) / 10 : undefined,
    },
  ];

  return { servers, projects: [...projects.values()], environments: [...environments.values()], services };
}
