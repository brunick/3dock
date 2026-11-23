/**
 * Visual role of one service. Dokploy knows the kind; a plain Docker engine does not, so we
 * read the image first and the container name second. This is a heuristic, not a contract.
 */
import { KIND_COLOR } from '../theme';
import { isDb, type Service } from './types';

export type UnitRole = 'database' | 'cache' | 'proxy' | 'worker' | 'web' | 'generic';

/** Tank-shaped units: databases and caches. */
export const isTank = (role: UnitRole) => role === 'database' || role === 'cache';

const DATABASE = /(mysql|mariadb|postgres|postgresql|mongo|libsql|sqlite|clickhouse|influx|cockroach|timescale|percona)/i;
const CACHE = /(redis|valkey|memcached|keydb|dragonfly)/i;
const PROXY = /(traefik|caddy|nginx|haproxy|envoy|varnish)/i;
const WORKER = /(worker|cron|queue|consumer|job|celery|scheduler|sidekiq|bullmq|horizon)/i;
const WEB = /(web|api|app|server|frontend|backend|http|django|rails|express|next|nuxt|gunicorn|uvicorn)/i;

/** Dokploy's own kind wins; otherwise the image, then the name. */
export function unitRole(svc: Service): UnitRole {
  if (isDb(svc.kind)) return svc.kind === 'redis' ? 'cache' : 'database';

  const image = (svc.source ?? '').toLowerCase();
  const name = svc.name.toLowerCase();
  const match = (re: RegExp) => re.test(image) || re.test(name);

  if (match(DATABASE)) return 'database';
  if (match(CACHE)) return 'cache';
  if (match(PROXY)) return 'proxy';
  if (match(WORKER)) return 'worker';
  if (match(WEB)) return 'web';
  return 'generic';
}

export const ROLE_COLOR: Record<UnitRole, string> = {
  database: '#ffb547',
  cache: '#ff5a4f',
  proxy: '#7c6cff',
  worker: '#ff7a45',
  web: '#2de2ff',
  generic: '#2de2ff',
};

/** Trim / band colour: Dokploy's precise kind colour when it has one, the role colour otherwise. */
export const unitTint = (svc: Service) => (isDb(svc.kind) ? KIND_COLOR[svc.kind] : ROLE_COLOR[unitRole(svc)]);
