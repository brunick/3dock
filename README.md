# 3Dokploy

**Your [Dokploy](https://dokploy.com) — or a plain local Docker engine — as a living, isometric
server floor.** Projects become buildings, environments become zones, services become racks and
database tanks. Deploys roll in on carts, network traffic flows in as packets, and a technician
walks over to whatever goes down.

![3Dokploy with example projects](docs/screenshot.jpg)

- **Live** – status, CPU, memory and network per service, an activity feed. With Dokploy also
  deployments with their real build log, failed-deploy alerts and environments.
- **Read-only by default** – 3Dokploy can't deploy, stop or change anything. In the Docker
  backend, container start/stop/restart can be enabled explicitly (see below).
- **Self-hosted** – run it next to your Dokploy, against a plain Docker engine, or on your own
  machine. Credentials stay in the server's environment and never reach the browser.
- **A floor plan that reacts** – databases and caches become tanks, web servers get a blade
  front, proxies a routing ring and workers a turning gear. Technicians sprint to outages and
  stack actions, curse about them, and stay put when something fails.

> This project is a fork of [suleyman/3dokploy](https://github.com/suleyman/3dokploy) (MIT).
> It keeps the original concept and Dokploy backend and adds a local Docker backend, container
> control, the technician crew and role-based unit designs. Not affiliated with the Dokploy
> project.

## Quick start

Two backends, selected with `BACKEND`:

- **`dokploy`** (default) reads your Dokploy through its API. Needs an API key, created in
  Dokploy under **Settings → Profile → API/CLI**.
- **`docker`** reads the local Docker engine through a small read-only Go proxy. Needs only the
  Docker socket — see [Against a local Docker engine](#against-a-local-docker-engine).

### On your machine

Requires Node.js 22.6 or newer.

```sh
git clone https://github.com/brunick/3dock.git && cd 3dock
cp .env.example .env.local   # set DOKPLOY_URL and DOKPLOY_API_KEY
npm install
npm run build
npm start                    # → http://localhost:3000
```

### Docker Compose

```sh
git clone https://github.com/brunick/3dock.git && cd 3dock
cp .env.example .env         # set DOKPLOY_URL and DOKPLOY_API_KEY
docker compose up -d
```

Open <http://localhost:3000>. Dokploy itself listens on port 3000, so on the same machine set
`HOST_PORT=3100` (or any free port) in `.env`, and use `DOKPLOY_URL=http://host.docker.internal:3000`
to reach it.

### Against a local Docker engine

Docker has no Dokploy API, so 3Dokploy reads the engine directly through `proxy/`, a small Go
service. It speaks the Docker socket and exposes only a fixed set of endpoints: version, info,
container list, one container, container logs and container stats. It never forwards arbitrary
paths and cannot change anything by default.

Locally, run the proxy next to the app:

```sh
npm run dev:proxy            # terminal 1 → http://127.0.0.1:3101
BACKEND=docker npm start     # terminal 2 → http://localhost:3000
```

With Compose (set `BACKEND=docker` and `DOCKER_GID=$(stat -c %g /var/run/docker.sock)` in `.env`):

```sh
docker compose --profile docker up -d --build
```

What maps: Compose projects become buildings, containers become racks, and CPU, memory, network,
health and status are live. Unit designs follow the container's role, derived from the Dokploy
kind, the image and then the name:

| Role | Looks like |
| --- | --- |
| database, cache | tank with glowing bands |
| web / API | cabinet with a blade front and status lights |
| proxy | cabinet with a slowly turning routing ring |
| worker | cabinet with a gear that turns with CPU load |
| everything else | plain cabinet |

What does not: Docker has no deployments, build logs or commit metadata, so the deploy pipeline
stays empty. Domains are not shown either — Docker does not know them.

**Container control (start / stop / restart).** Off by default. Set
`ALLOW_CONTAINER_CONTROL=true` for both the proxy and the app to enable the buttons in the
inspector and next to a building's door (for a whole Compose stack):

```sh
ALLOW_CONTAINER_CONTROL=true npm run dev:proxy
BACKEND=docker ALLOW_CONTAINER_CONTROL=true npm start
```

or, with Compose:

```sh
BACKEND=docker ALLOW_CONTAINER_CONTROL=true docker compose --profile docker up -d --build
```

Those requests are same-origin only, but anyone who can open the page can then stop and restart
containers. Use `BASIC_AUTH` or keep it on your machine. With the switch off, the Docker backend
is read-only exactly like the Dokploy one. A stack is started container by container
(databases first, stopped last), which approximates `depends_on` but is not `docker compose`.

The Docker socket grants host-level privileges. The proxy binds to `127.0.0.1` by default and the
switch is off by default; still, anyone who can reach the proxy can read the whole Docker host.

### On Dokploy

**As a template:** `templates/dokploy/3dokploy/` holds a ready Dokploy template (compose file,
`template.toml`, metadata, logo). It points `DOKPLOY_URL` at the Dokploy on the same server and
turns on basic auth with a generated password; paste your API key into `DOKPLOY_API_KEY`.

**From the repository:** create an application from this repository with the **Dockerfile**
build type and port **3000**, set the variables below, then add a domain.

### Configuration

| Variable | Default | |
| --- | --- | --- |
| `BACKEND` | `dokploy` | `dokploy` or `docker` |
| `ALLOW_CONTAINER_CONTROL` | `false` | Docker mode: expose start/stop/restart |
| `DOKPLOY_URL` | *dokploy mode* | Your Dokploy, e.g. `https://dokploy.example.com` or `http://host.docker.internal:3000` |
| `DOKPLOY_API_KEY` | *dokploy mode* | A Dokploy API key. Only the server uses it. |
| `DOCKER_PROXY_URL` | `http://127.0.0.1:3101` | Docker mode: address of the Go proxy |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Proxy: Docker Engine socket |
| `DOCKER_GID` | – | Compose only: the socket's group id |
| `BASIC_AUTH` | – | `user:password` login for the page |
| `PORT` | `3000` | Port the server listens on |
| `HOST_PORT` | `3000` | Compose: published host port |

Without `BASIC_AUTH`, **anyone who can open the page sees your Dokploy or your Docker host**
(read-only by default; Dokploy secrets are stripped). Put it behind HTTPS if it's reachable from
the internet.

## Controls

| | |
| --- | --- |
| Click a building or its nameplate | Fly to the project, open its panel |
| Click a rack / tank | Select the service, open the inspector |
| `Esc` | Back out: service → project → overview |
| `Space` + drag, two-finger scroll, right/middle drag, arrow keys | Pan |
| Mouse wheel, pinch, `+` / `-` | Zoom (towards the cursor) |
| Left drag | Rotate |
| `F` / `Shift+F` / `R` | Frame the selection / fullscreen / reset the view |
| `/` | Filter nodes |
| `M` | Sound on/off |

With container control enabled, the inspector shows **Start / Stop / Restart** for one container,
and a stack with more than one container gets **Start all / Stop all / ⟳** next to its entrance.

## How it works

The UI is a React + three.js app. A small **Node.js** server (Hono, no database) serves it and
answers its data calls. Browsers can't reach the upstream directly — Dokploy sends no CORS
headers and the key must stay off the page, and Docker lives behind a Unix socket — so the page
calls `/api/...` on this server:

```
browser ──/api/docker/...──▶ 3Dokploy server ──HTTP──▶ Go proxy ──unix──▶ Docker engine
browser ──/api/<procedure>─▶ 3Dokploy server ──x-api-key──▶ Dokploy
   └─ polling, diffing, metrics all happen here
```

- An **allowlist of endpoints** is forwarded (`server/dokploy.ts`, `server/docker.ts`); all
  others are refused. With the Docker backend, `ALLOW_CONTAINER_CONTROL=true` adds
  start/stop/restart, and only same-origin requests are accepted for those.
- **Secrets are stripped** from Dokploy responses before they reach the browser: env vars,
  passwords, tokens, build secrets (3Dokploy never needs them).
- Docker container types are a **heuristic** (kind, then image, then name), used only for the
  unit design.
- No database, no sessions, nothing stored. Same-origin only, with a strict Content-Security-Policy.

## Development

```sh
npm install
npm run dev        # Vite on :5173 (open this) + the API server on :3000 behind it
npm run build      # typecheck + production build into dist/
npm start          # serve dist/ and the API on :3000
```

`npm run dev` reads `DOKPLOY_URL` and `DOKPLOY_API_KEY` from `.env.local` as well.

For the Docker backend, start the proxy too and switch the API to it:

```sh
npm run dev:proxy            # terminal 1
BACKEND=docker npm run dev   # terminal 2
```

### Layout

```
proxy/                 read-only Go proxy in front of the Docker socket
server/                read-only forwarding (Dokploy allowlist / Docker routes) + static file server
src/data/dokploy/      Dokploy API client and the collector that polls and diffs (runs in the browser)
src/data/docker/       Docker API client and the collector that polls and diffs (runs in the browser)
src/data/roles.ts      container role heuristic (database, cache, proxy, worker, web)
src/data/              types, the data source
src/layout.ts          projects → buildings, services → racks, walking routes
src/scene/             three.js scene (react-three-fiber): buildings, racks, agents, effects
src/hud/               overlay UI: top bar, menus, KPIs, inspector, pipeline
src/sound.ts           UI sounds, synthesised with Web Audio
templates/dokploy/     Dokploy template
```

### Releasing

Pushing a tag like `v0.2.0` publishes an image through GitHub Actions (amd64 + arm64). The
compose file builds locally; add an `image:` for the registry you publish to.

## Notes and limits

- With Dokploy, metrics come from `docker stats` on the Dokploy host (Dokploy's monitoring
  service isn't required). Services on remote Dokploy servers show status and deploys, but no
  metrics yet.
- With Docker, metrics come straight from the engine's container stats. There are no
  deployments, build logs or domains, because Docker keeps no such records.
- A stopped container is `error` only when the process failed (exit code 1–125). Exit 0 and
  signal exits — 143 after `docker stop`, 137 after `docker kill` — are shown as `idle`.
- Technicians visit every rack of a stack in order, sprint to fresh actions, turn around when a
  new job arrives on their way home, and linger at a rack whose action failed.
- `docker stats` rounds network counters, so traffic rates are estimates over a short window.
- Polling pauses while the tab is in the background.
- Enabling `ALLOW_CONTAINER_CONTROL` changes the read-only guarantee: the page can then stop and
  restart containers.

## Credits and license

[MIT](LICENSE).

Built on [suleyman/3dokploy](https://github.com/suleyman/3dokploy) — the original isometric
Dokploy floor, its scene, data model and Dokploy integration. This fork adds the Docker backend
and Go proxy, container control, the technician crew and role-based unit designs:
[brunick/3dock](https://github.com/brunick/3dock).

Dokploy is a separate open-source project; 3Dokploy is not affiliated with it.
