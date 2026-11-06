# Nexus Deploy — Agent Guide

## Purpose
A free, open-source alternative to paid deployment platforms (Railway, Render) by The No Hands Company. Deploy a Git repo or a container image and get a live HTTPS app. A general service for anyone: no Nexus app is special to it.

## Architecture
```
GitHub push
  → POST /api/webhooks/github/:projectId   (HMAC verified, per-project secret)
  → createDeployment()                      (sync write to DB, returns ID)
  → runDeploy()                             (async, fire-and-forget)
      git clone
      → nixpacks build  OR  docker build (if Dockerfile present)
      → docker run (Traefik labels, volume mounts, resource limits)
  → WebSocket /api/log-stream               (build log streaming per deploymentId)
  → WebSocket /api/container-stream         (runtime stdout/stderr streaming)
  → SSE        /api/events?token=           (instant project status updates)
  → status-sync (30s poll Docker, corrects DB, emits SSE events)
  → image-prune (hourly, removes unused nexus/* images)
```

## Key files
| File | Purpose |
|---|---|
| `src/index.ts` | Express server, all routes, WS, SSE, boot |
| `src/lib/build.ts` | Clone → build → run → log pipeline |
| `src/lib/docker.ts` | Docker CLI: run/stop/start/restart/remove/status/stats/logs |
| `src/lib/status-sync.ts` | Background Docker status reconciliation + image pruning |
| `src/lib/events.ts` | In-process SSE event bus (decouples build ↔ status-sync) |
| `src/lib/store.ts` | AES-GCM encrypted JSON DB with async write queue |
| `src/lib/config.ts` | All env var config |
| `src/types.ts` | Shared TypeScript types |
| `web/src/App.tsx` | Full React dashboard (single-file SPA) |
| `web/src/styles/index.css` | Terminal-dark design system |
| `web/vite.config.ts` | Vite config with /api proxy for dev mode |

## API surface
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | /api/auth/login | — | Returns JWT |
| POST | /api/auth/register | — | Only if ALLOW_REGISTRATION=true |
| GET | /api/me | Bearer | Current user |
| GET | /api/events?token= | query | SSE status stream |
| GET | /api/projects | Bearer | All projects + latestDeployment |
| POST | /api/projects | Bearer | Create project |
| GET | /api/projects/:id | Bearer | Project + deployments |
| PUT | /api/projects/:id | Bearer | Update settings |
| DELETE | /api/projects/:id | Bearer | Delete + remove container |
| PUT | /api/projects/:id/env | Bearer | Set env vars |
| POST | /api/projects/:id/deploy | Bearer | Trigger build |
| POST | /api/projects/:id/stop | Bearer | Stop container |
| POST | /api/projects/:id/start | Bearer | Start container |
| POST | /api/projects/:id/restart | Bearer | Restart container |
| GET | /api/projects/:id/stats | Bearer | Live CPU/mem/net stats |
| GET | /api/projects/:id/health | Bearer | Docker status check |
| POST | /api/projects/:id/regen-webhook-secret | Bearer | New webhook secret |
| POST | /api/deployments/:id/rollback | Bearer | Re-run existing image |
| GET | /api/deployments/:id/logs | Bearer | Deployment log array |
| GET | /api/activity | Bearer | Last 25 deploys across projects |
| POST | /api/webhooks/github/:projectId | HMAC | GitHub push webhook |
| WS | /api/log-stream?deploymentId=&token= | query | Build log stream |
| WS | /api/container-stream?projectId=&token= | query | Runtime log stream |
| POST | /api/deployments/:id/cancel | Bearer | Cancel in-progress build |

## Auth
Token accepted as:
- `Authorization: Bearer <token>` — for all API calls
- `?token=<token>` — for SSE (EventSource) and WebSocket (browser limitation)

## How it fits together (v0.6)
- `src/app.ts` builds the HTTP app from injected dependencies (`AppDeps`); `src/index.ts` only wires the real ones and listens. Tests inject fakes, so nothing needs Nexus-Auth, Docker or Git.
- **Members and ownership** (`lib/members.ts`): Nexus-Auth proves identity; an operator (Auth founder/admin) lets accounts in. Every project has an `ownerId`; another member's project answers 404, exactly like a missing one. Operators see all.
- **Sources** (`lib/source.ts`): a project has one source, Git or image. A private-repo token is handed to git by an askpass helper, never put in a URL, argument, log or API response.
- **Pipeline** (`lib/build.ts`): clone/build or pull, then `lib/release.ts` starts the new container on its own loopback port, proves it healthy, tells the ingress through a `RoutePublisher`, then stops the old one (blue/green). A project with a data volume releases stop-then-start instead.
- **Sandbox**: every `docker`/`nixpacks` call is forced to `SANDBOX_DOCKER_HOST` and refuses to run without it. Never fall back to the host daemon. App containers are started only through `lib/run-args.ts`, which drops all capabilities and caps CPU, memory, processes and logs.
- **Privacy**: no visitor address is read or stored anywhere (scripts/check-privacy.sh in the monorepo enforces it). The audit log records account, action and time only, for thirty days.
- Node-specific values (`BASE_DOMAIN`, `APP_HOST_PATTERN`, `CONTROL_HOST`, `SANDBOX_*`, `APP_PORT_RANGE`, `CAP_*`) are configuration; no source file may name a domain (a test enforces it).

## Testing
- `node --import tsx --test tests/*.test.ts` runs everything; `npm run typecheck` and `npm run typecheck:tests` must be clean. New code must also pass `biome check` (the older files still have a lint backlog, which is not part of any slice).
- On a filesystem that cannot execute binaries, point `ESBUILD_BINARY_PATH` at an executable copy of esbuild.

## Conventions
- Keep it lean. No ORM, no message queue, no microservices.
- All DB writes go through `writeDb(mutate)` — never call `saveDb` during builds.
- `saveDb` is only for boot-time seeding where no concurrent writes exist.
- Per-project build lock via `buildingProjects Set<string>` in build.ts.
- `emitStatusChange` in events.ts is the single bus for project status changes.
- Image naming: `nexus/{project-name}:{8-char-deployment-id}`
- Container naming: `nexus-app-{project-name}`
- Volume naming: `nexus-vol-{project-name}` (mounted at project.volumePath)
- Never add billing, plans or paywalls. Free forever. Safeguards that protect a shared node (container caps, build limits, the disk guard) are allowed and apply equally to everyone; an operator tunes them for the whole node with CAP_* variables.

## Standards Enforcement
- Follow ../docs/ENGINEERING_STANDARDS.md as the baseline for TypeScript quality, API behavior, observability, and security.
- Preserve event-driven deployment flow. GitHub webhooks, WS streams, SSE updates, and status propagation are the preferred coordination model; do not regress to polling-heavy orchestration.
- Treat Nexus-Cloud as the upstream ecosystem nerve system for registration, topology, and routing coordination.
- Keep degraded-mode behavior explicit: if Docker, GitHub, or a downstream dependency fails, surface that through state changes, logs, and retry/circuit logic rather than silent failure.

## Dev
```bash
npm install && npm --prefix web install
npm run dev          # tsx watch + vite (with /api proxy)
npm run build        # prod build
npm run typecheck    # tsc --noEmit
```

## Validation Target
- `npm run check`
- `npm test` when behavior changes touch runtime code
