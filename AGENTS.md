# Nexus Deploy — Agent Guide

## Purpose
Self-hosted Railway-style deployment platform by The No Hands Company.
Push to GitHub → auto-build → live HTTPS app. Free forever, no billing, ever.

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

## Auth
Token accepted as:
- `Authorization: Bearer <token>` — for all API calls
- `?token=<token>` — for SSE (EventSource) and WebSocket (browser limitation)

## Conventions
- Keep it lean. No ORM, no message queue, no microservices.
- All DB writes go through `writeDb(mutate)` — never call `saveDb` during builds.
- `saveDb` is only for boot-time seeding where no concurrent writes exist.
- Per-project build lock via `buildingProjects Set<string>` in build.ts.
- `emitStatusChange` in events.ts is the single bus for project status changes.
- Image naming: `nexus/{project-name}:{8-char-deployment-id}`
- Container naming: `nexus-app-{project-name}`
- Volume naming: `nexus-vol-{project-name}` (mounted at project.volumePath)
- Never add billing, limits, or feature gates. Free forever.

## Dev
```bash
npm install && npm --prefix web install
npm run dev          # tsx watch + vite (with /api proxy)
npm run build        # prod build
npm run typecheck    # tsc --noEmit
```
