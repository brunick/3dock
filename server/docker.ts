/**
 * Docker backend: forwards the browser's read-only reads to the local Go proxy
 * (proxy/main.go), which speaks the Docker Engine API over the Unix socket.
 *
 * Why it exists: the browser can only talk to this server (same origin, CSP), and the
 * Docker socket must not be exposed. The proxy itself refuses everything but GET.
 *
 * What it guarantees:
 *  - only the routes registered in server/index.ts can be reached, with fixed paths
 *  - only GET, and only the log `tail` query parameter is forwarded
 *  - the proxy's error shape ({"error": "..."}) is passed through unchanged
 */
import type { Context } from 'hono';

const DEFAULT_URL = 'http://127.0.0.1:3101';
const TIMEOUT_MS = 15_000;
export const STATS_TIMEOUT_MS = 30_000;
/** Stops may use Docker's whole grace period, so control requests wait longer than the proxy. */
const CONTROL_TIMEOUT_MS = 35_000;

/** Reads the proxy address from the environment, or explains what is wrong. */
export function loadDockerTarget(): { url: string } {
  const raw = process.env.DOCKER_PROXY_URL?.trim() || DEFAULT_URL;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`DOCKER_PROXY_URL is not a valid URL: ${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`DOCKER_PROXY_URL must be http(s), not ${u.protocol}`);
  }
  return { url: `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}` };
}

/** A network failure, in words that point at the fix. */
function describe(e: unknown, url: URL) {
  if ((e as Error).name === 'TimeoutError') return 'The Docker proxy did not answer in time.';
  const code = ((e as { cause?: { code?: string } }).cause?.code ?? '') as string;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Can't resolve ${url.hostname}. Check DOCKER_PROXY_URL.`;
  if (code === 'ECONNREFUSED') return `${url.host} refused the connection. Is the Docker proxy running?`;
  return `Can't reach the Docker proxy at ${url.host}${code ? ` (${code})` : ''}.`;
}

/** A fixed proxy path, or one derived from the request. */
type Path = string | ((c: Context) => string);

export type ControlAction = 'start' | 'stop' | 'restart';

/**
 * POSTs one control action to the proxy. Registered only when the server runs with
 * ALLOW_CONTAINER_CONTROL enabled; the proxy enforces the same switch.
 */
export function controlDocker(target: { url: string }, action: ControlAction) {
  return async (c: Context) => {
    // A cross-site form post must not be able to stop containers.
    const site = c.req.header('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') {
      return c.json({ error: 'Cross-site control requests are refused.' }, 403);
    }

    const id = c.req.param('id') ?? '';
    const url = new URL(`${target.url}/containers/${encodeURIComponent(id)}/${action}`);
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS) });
    } catch (e) {
      return c.json({ error: describe(e, url) }, 502);
    }
    // 304 means the container is already in that state, which is not a failure here.
    if (!res.ok && res.status !== 304) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return c.json({ error: body?.error ?? `Docker proxy → ${res.status}` }, res.status === 404 ? 404 : 502);
    }
    c.header('cache-control', 'no-store');
    return c.json({ ok: true, action, id });
  };
}

export function proxyDocker(target: { url: string }, path: Path, timeoutMs = TIMEOUT_MS) {
  return async (c: Context) => {
    const url = new URL(`${target.url}${typeof path === 'function' ? path(c) : path}`);
    if (c.req.path.endsWith('/logs')) {
      const tail = Math.min(Math.max(Number(c.req.query('tail')) || 200, 1), 500);
      url.searchParams.set('tail', String(tail));
    }

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return c.json({ error: describe(e, url) }, 502);
    }

    const type = res.headers.get('content-type') ?? '';
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return c.json({ error: body?.error ?? `Docker proxy → ${res.status}` }, res.status === 404 ? 404 : 502);
    }

    c.header('cache-control', 'no-store');
    if (type.includes('text/plain')) {
      c.header('content-type', 'text/plain; charset=utf-8');
      return c.body(await res.text());
    }
    const body = (await res.json().catch(() => null)) as unknown;
    if (body === null) return c.json({ error: 'The Docker proxy sent malformed JSON.' }, 502);
    return c.json(body as Record<string, unknown> | unknown[]);
  };
}
