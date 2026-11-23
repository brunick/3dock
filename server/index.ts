/**
 * 3Dokploy server: forwards the browser's read-only Dokploy calls (/api/<procedure>) with the API
 * key from its environment and, in production, serves the built web app from ./dist. A plain
 * Node.js process (Hono), no database, no sessions.
 *
 * Two backends, chosen with BACKEND: "dokploy" (default) reads your Dokploy with
 * DOKPLOY_URL and DOKPLOY_API_KEY; "docker" reads the local engine through the Go proxy
 * at DOCKER_PROXY_URL. BASIC_AUTH guards the page when it is reachable by others.
 *
 * Plain, erasable TypeScript so Node ≥ 22.6 runs it directly (`node server/index.ts` on Node 24).
 */
import './env.ts';
import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { forward, loadTarget } from './dokploy.ts';
import { STATS_TIMEOUT_MS, controlDocker, loadDockerTarget, proxyDocker } from './docker.ts';

const PORT = Number(process.env.PORT ?? 3000);
const STATIC_DIR = process.env.STATIC_DIR ?? 'dist';
const AUTH = /^([^:]+):(.+)$/.exec(process.env.BASIC_AUTH ?? '');

const BACKEND = (process.env.BACKEND ?? 'dokploy').trim().toLowerCase();
/** Docker mode only: expose start/stop/restart. Off by default. */
const ALLOW_CONTROL = /^(1|true|yes|on)$/i.test(process.env.ALLOW_CONTAINER_CONTROL ?? '');
if (BACKEND !== 'dokploy' && BACKEND !== 'docker') {
  console.error(`[3dokploy] BACKEND must be "dokploy" or "docker", not "${BACKEND}".`);
  process.exit(1);
}

let dokploy: ReturnType<typeof loadTarget> | null = null;
let docker: ReturnType<typeof loadDockerTarget> | null = null;
try {
  if (BACKEND === 'docker') docker = loadDockerTarget();
  else dokploy = loadTarget();
} catch (e) {
  console.error(`[3dokploy] ${(e as Error).message}`);
  process.exit(1);
}

// Same-origin everything: the page only ever talks to this server.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const app = new Hono();

app.get('/healthz', (c) => c.json({ ok: true, backend: BACKEND, allowControl: ALLOW_CONTROL }));

if (AUTH) app.use('*', basicAuth({ username: AUTH[1], password: AUTH[2], realm: '3Dokploy' }));

app.use('*', async (c, next) => {
  await next();
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'no-referrer');
  if (!c.req.path.startsWith('/api/')) {
    c.header('content-security-policy', CSP);
    // The HTML references hashed bundles; a cached page keeps an old build alive.
    if (c.req.path === '/' || c.req.path === '/index.html') c.header('cache-control', 'no-cache');
  }
});

if (BACKEND === 'docker') {
  const t = docker!;
  app.get('/api/docker/version', proxyDocker(t, '/version'));
  app.get('/api/docker/info', proxyDocker(t, '/info'));
  app.get('/api/docker/containers', proxyDocker(t, '/containers'));
  app.get('/api/docker/containers/:id', proxyDocker(t, (c) => `/containers/${encodeURIComponent(c.req.param('id') ?? '')}`));
  app.get('/api/docker/containers/:id/logs', proxyDocker(t, (c) => `/containers/${encodeURIComponent(c.req.param('id') ?? '')}/logs`));
  app.get('/api/docker/stats', proxyDocker(t, '/stats', STATS_TIMEOUT_MS));
  if (ALLOW_CONTROL) {
    app.post('/api/docker/containers/:id/start', controlDocker(t, 'start'));
    app.post('/api/docker/containers/:id/stop', controlDocker(t, 'stop'));
    app.post('/api/docker/containers/:id/restart', controlDocker(t, 'restart'));
  }
} else {
  app.get('/api/:procedure', forward(dokploy!));
}
app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

if (existsSync(STATIC_DIR)) {
  app.use('/*', serveStatic({ root: STATIC_DIR }));
  app.get('*', serveStatic({ path: `${STATIC_DIR}/index.html` })); // single page app
}

serve({ fetch: app.fetch, port: PORT }, () => {
  const ui = existsSync(STATIC_DIR) ? 'app + api' : 'api only (run "npm run build" to serve the app)';
  const target = BACKEND === 'docker' ? `docker via ${docker!.url}` : dokploy!.url;
  console.log(`[3dokploy] ${ui} on http://localhost:${PORT} → ${target}${AUTH ? ' (basic auth)' : ''}`);
  if (!AUTH) console.log('[3dokploy] No BASIC_AUTH: anyone who can open this address sees the upstream (read-only).');
});
