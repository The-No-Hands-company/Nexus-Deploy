# Nexus Deploy — Agent Guide

## Purpose
A free, open-source alternative to paid deployment platforms (Railway, Render) by The No Hands Company. Deploy a Git repository or a container image and get a live HTTPS app. A general service for anyone: no Nexus app is special to it.

## Architecture (v0.6)
```
GitHub push / manual deploy
  → POST /api/webhooks/github/:projectId (HMAC verified) or POST /api/projects/:id/deploy
  → createDeployment()                      (writes queued deployment to encrypted store)
  → runDeploy()                             (async pipeline in src/lib/build.ts)
      Git source:   git clone (askpass for private repos)
                    → Dockerfile build OR Railpack (buildkit frontend, zero privileged containers)
      Image source: docker pull → pinned @sha256 digest
  → runRelease()                            (src/lib/release.ts)
      → allocate free loopback port in APP_PORT_RANGE (default 20000-29999)
      → docker run on SANDBOX_DOCKER_HOST (rootless, --cap-drop ALL, no-new-privileges, resource & log caps)
      → HTTP health probe on 127.0.0.1:<hostPort><healthPath>
      → publish route to Nexus Cloud (/api/v1/user-apps/:slug with userDeployed=true)
      → blue/green drain & stop previous container (or stop-then-start when volumePath is set)
  → WebSocket /api/log-stream               (build log streaming per deploymentId)
  → WebSocket /api/container-stream         (runtime stdout/stderr streaming)
  → SSE       /api/events                   (project status updates for the caller's projects)
  → status-sync (30s poll sandbox Docker, corrects DB, emits SSE events)
  → image-prune (hourly, removes unreferenced images in the dedicated sandbox daemon)
```

## Key files
| File | Purpose |
|---|---|
| `src/app.ts` | Express app factory built from injected dependencies (`AppDeps`) |
| `src/index.ts` | Production entrypoint wiring real dependencies and starting the server |
| `src/lib/wiring.ts` | Wires Nexus-Auth, sandbox Docker ops, and Cloud route publisher |
| `src/lib/build.ts` | Clone/build or pull → release → rollback pipeline |
| `src/lib/build-steps.ts` | Git askpass clone, Dockerfile / Railpack image build, OCI image pull |
| `src/lib/release.ts` | Blue/green and stop-then-start container release state machine |
| `src/lib/run-args.ts` | Hardened `docker run` argument builder (`--cap-drop ALL`, caps, log limits) |
| `src/lib/docker.ts` | Sandbox-enforced Docker/Railpack CLI wrapper (`SANDBOX_DOCKER_HOST` required) |
| `src/lib/cloud.ts` | Nexus Cloud `user-apps` route publisher + heartbeat |
| `src/lib/edge.ts` | Combines Cloud publisher with Hosting + Cloud slug availability checks |
| `src/lib/members.ts` | Invite-only member list, first-founder seeding, per-project ownership |
| `src/lib/safeguards.ts` | Node-wide per-member quotas, rate limits, timeouts, and disk guard |
| `src/lib/store.ts` | AES-256-GCM encrypted JSON DB with serialized async `writeDb` queue |
| `src/doctor/` | `npm run doctor` static preflight (13 checks across sandbox, builder, DNS, Cloud, UI) |
| `src/verify/` | `npm run verify` live end-to-end conformance suite using bundled `fixtures/` |
| `sandbox/setup.sh` | Operator `sudo` script provisioning the rootless sandbox user, loop disk, and nftables egress filter |
| `sandbox/install-builder.sh` | User-scoped Railpack `v0.43.0` installer (`~/.local/bin/railpack`) |
| `web/src/` | React + Vite dashboard using the shared Void theme (`nexus-tokens.css`) |

## API surface
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/health` | Public | Liveness check |
| GET | `/api/auth/login` | Public | Redirects browser to `NEXUS_AUTH_PUBLIC_URL/login` |
| GET | `/api/auth/logout` | Public | Redirects browser to `NEXUS_AUTH_PUBLIC_URL/logout` |
| GET | `/api/me` | Auth | Current identity, member/operator access, node info, and `wsToken` |
| GET | `/api/limits` | Member | Node safeguards, domain patterns, and `best-effort` availability |
| GET | `/api/events` | Member | SSE status stream for projects visible to the caller |
| GET | `/api/activity` | Member | Last 25 deployments across projects visible to the caller |
| GET | `/api/projects` | Member | Caller's projects (or all for operators) + `latestDeployment` |
| POST | `/api/projects` | Member | Create Git or OCI image project (checks slug in Cloud + Hosting) |
| GET | `/api/projects/:id` | Owner/Op | Project details + deployments |
| PUT | `/api/projects/:id` | Owner/Op | Update project settings / source / private token |
| DELETE | `/api/projects/:id` | Owner/Op | Remove containers, route, volume, images, logs, and project |
| GET | `/api/projects/:id/export` | Owner/Op | Export portable project JSON (omits credentials) |
| PUT | `/api/projects/:id/env` | Owner/Op | Validate and save encrypted environment variables |
| POST | `/api/projects/:id/deploy` | Owner/Op | Trigger deployment |
| POST | `/api/projects/:id/stop` | Owner/Op | Stop running container |
| POST | `/api/projects/:id/start` | Owner/Op | Start stopped container |
| POST | `/api/projects/:id/restart` | Owner/Op | Restart container |
| GET | `/api/projects/:id/stats` | Owner/Op | Live CPU/memory/network container stats |
| GET | `/api/projects/:id/health` | Owner/Op | Container status check |
| POST | `/api/projects/:id/regen-webhook-secret` | Owner/Op | Rotate GitHub webhook HMAC secret |
| POST | `/api/deployments/:id/rollback` | Owner/Op | Roll back to a deployment's recorded image or `@sha256` digest |
| POST | `/api/deployments/:id/cancel` | Owner/Op | Cancel an in-progress build |
| GET | `/api/deployments/:id/logs` | Owner/Op | Build log lines and deployment status |
| DELETE | `/api/deployments/:id/logs` | Owner/Op | Erase a finished deployment's build log |
| GET | `/api/admin/members` | Operator | List invited members |
| POST | `/api/admin/members` | Operator | Grant member access (`authUserId`, optional `label`) |
| PATCH | `/api/admin/members/:authUserId` | Operator | Suspend or reactivate a member |
| GET | `/api/admin/audit` | Operator | 30-day zero-IP audit trail |
| POST | `/api/webhooks/github/:projectId` | HMAC | GitHub push webhook (`X-Hub-Signature-256`) |
| WS | `/api/log-stream?deploymentId=&token=` | Ticket/Token/Cookie | Real-time build log stream |
| WS | `/api/container-stream?projectId=&token=` | Ticket/Token/Cookie | Real-time container stdout/stderr stream |

## Auth
Identity is delegated to **Nexus-Auth** (`GET /api/v1/auth/check`):
- `Authorization: Bearer <token>` — for API clients
- `Cookie: nexus_session=<token>` — shared `HttpOnly` ecosystem session cookie for browsers
- `?token=<wsToken|sessionToken>` — for WebSocket upgrades through the edge proxy (`GET /api/me` issues a short-lived HMAC `wsToken` so `nexus_session` stays `HttpOnly`)

## Conventions
- Keep it lean. No ORM, no message queue, no microservices.
- All DB writes go through `writeDb(mutate)` — never call `saveDb` during builds.
- `saveDb` is only for boot-time seeding or test resets where no concurrent writes exist.
- Image naming for Git builds: `nexus/{project-name}:{8-char-deployment-id}`
- Container naming: `nexus-app-{project-name}-{8-char-deployment-id}` (`src/lib/containers.ts`) so blue/green releases can run old and new containers side by side during cutover.
- Volume naming: `nexus-vol-{project-name}` (mounted at `project.volumePath`).
- **Sandbox enforcement**: every `docker` and `railpack` call requires `SANDBOX_DOCKER_HOST` and never falls back to the host daemon.
- **Privacy**: never read or store visitor IP addresses or user agents (`scripts/check-privacy.sh` enforces this across the monorepo). The audit log records only account ID, action, subject, and timestamp, retained for 30 days.
- **Portability**: node-specific values (`BASE_DOMAIN`, `APP_HOST_PATTERN`, `CONTROL_HOST`, `SANDBOX_*`, `APP_PORT_RANGE`, `CAP_*`) live in `src/lib/config.ts`. No `src/` or `web/src/` file may hardcode `tnhc.dev` (`tests/no-hardcoded-domain.test.ts`).
- **No billing**: Never add billing, plans or paywalls; safeguards protect the node and apply equally.

## Dev & Quality Gate
```bash
npm install && npm --prefix web install
./check.sh           # typecheck (server, tests, web) + full unit test suite
npm run doctor       # static 13-check node & sandbox readiness report
npm run verify       # live 8-step end-to-end conformance suite against the sandbox daemon
```
