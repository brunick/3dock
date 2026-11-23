/**
 * Visual role of one service. Dokploy knows the kind; a plain Docker engine does not, so we
 * read the image first and the container name second. This is a heuristic, not a contract.
 */
import { KIND_COLOR } from '../theme';
import { isDb, type Service } from './types';

export type UnitRole =
  | 'database'
  | 'cache'
  | 'proxy'
  | 'worker'
  | 'web'
  | 'frontend'
  | 'backend'
  | 'api'
  | 'auth'
  | 'generic';

/** Tank-shaped units: databases and caches. */
export const isTank = (role: UnitRole) => role === 'database' || role === 'cache';

const DATABASE = /(mysql|mariadb|postgres|postgresql|postgis|mongo|libsql|sqlite|clickhouse|influx|cockroach|timescale|percona)/i;
const CACHE = /(redis|valkey|memcached|keydb|dragonfly)/i;
const AUTH = /(keycloak|oauth|oidc|authentik|authelia|openldap|ldap|vault)/i;
const PROXY = /(traefik|caddy|nginx|haproxy|envoy|varnish|proxy|gateway)/i;
const WORKER = /(worker|cron|queue|consumer|job|celery|scheduler|sidekiq|bullmq|horizon|crawl|crawler)/i;
const FRONTEND = /(^|[-_.])(frontend|front-end|ui|web-client|client)([-_.]|$)/i;
const BACKEND = /(^|[-_.])(backend|back-end|service|server)([-_.]|$)/i;
const API = /(^|[-_.])api([-_.]|$)/i;
const WEB = /(web|app|http|django|rails|express|next|nuxt|gunicorn|uvicorn)/i;
/** dev / test / staging markers, used for the warning beacon on top of the unit. */
const PRE_ENV = /(^|[-_.])(dev|develop|test|testing|staging|stage|qa|uat|sandbox|preview)([-_.]|$)/i;

/** Dokploy's own kind wins; otherwise the image, then the name. */
export function unitRole(svc: Service): UnitRole {
  if (isDb(svc.kind)) return svc.kind === 'redis' ? 'cache' : 'database';

  const image = (svc.source ?? '').toLowerCase();
  const name = svc.name.toLowerCase();
  const match = (re: RegExp) => re.test(image) || re.test(name);

  if (match(DATABASE)) return 'database';
  if (match(CACHE)) return 'cache';
  if (match(AUTH)) return 'auth';
  if (match(API)) return 'api';
  if (match(FRONTEND)) return 'frontend';
  // A proxy is usually also a "server": keep proxy ahead of backend.
  if (match(PROXY)) return 'proxy';
  if (match(BACKEND)) return 'backend';
  if (match(WORKER)) return 'worker';
  if (match(WEB)) return 'web';
  return 'generic';
}

/** Is this a dev, test, staging or similar non-production unit? */
export const isPreEnv = (svc: Service) =>
  PRE_ENV.test((svc.source ?? '').toLowerCase()) || PRE_ENV.test(svc.name.toLowerCase());

export const ROLE_COLOR: Record<UnitRole, string> = {
  database: '#ffb547',
  cache: '#ff5a4f',
  proxy: '#7c6cff',
  worker: '#ff7a45',
  web: '#2de2ff',
  frontend: '#19c6e6',
  backend: '#4f8bff',
  api: '#c86bff',
  auth: '#38e8a0',
  generic: '#2de2ff',
};

/** Trim / band colour: Dokploy's precise kind colour when it has one, the role colour otherwise. */
export const unitTint = (svc: Service) => (isDb(svc.kind) ? KIND_COLOR[svc.kind] : ROLE_COLOR[unitRole(svc)]);
