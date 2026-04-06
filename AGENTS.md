# Nexus Deploy — Agent Guide

## Purpose
Self-hosted Railway-style deployment platform by The No Hands Company.
Push to GitHub → auto-build → live HTTPS app. Free forever, no billing, ever.

## Architecture
```
GitHub push
  → /api/webhooks/github/:projectId   (HMAC verified, per-project secret)
  → createDeployment()                 (DB record, queued status)
  → runDeploy()                        (async, fire-and-forget)
      git clone → nixpacks/docker build → docker run + Traefik labels
  → WebSocket /api/log-stream          (live log streaming per deploymentId)
```

## Key files
| File | Purpose |
|---|---|
| `src/index.ts` | Express server, all routes, WebSocket, boot |
| `src/lib/build.ts` | Real build engine: clone → build → run → log |
| `src/lib/docker.ts` | Docker CLI wrapper (run, stop, start, remove, status) |
| `src/lib/status-sync.ts` | Background job: polls Docker, corrects DB status |
| `src/lib/store.ts` | AES-GCM encrypted JSON database |
| `src/lib/config.ts` | All env var config |
| `src/types.ts` | Shared TypeScript types |
| `web/src/App.tsx` | Full React dashboard (single file) |
| `web/src/styles/index.css` | Terminal-dark design system |

## Conventions
- Keep it lean. No ORM, no message queue, no microservices.
- `store.ts` is the database. It's an encrypted JSON file. Keep it simple.
- Every project gets a per-project `webhookSecret` (generated at creation).
- Webhook URL: `POST /api/webhooks/github/:projectId`
- Deploy trigger is always fire-and-forget. Logs stream via WebSocket.
- `status-sync` runs every 30s and corrects drift between Docker reality and DB.
- Never add billing, usage limits, or feature gates. Free forever.
- Preserve the data model: users → projects → deployments → logs.

## Dev setup
```bash
# Install deps
npm install && npm --prefix web install

# Run in dev mode (tsx watch + vite)
npm run dev

# Build for production
npm run build
```

## Environment variables
See `.env.example` for all required vars with descriptions.
