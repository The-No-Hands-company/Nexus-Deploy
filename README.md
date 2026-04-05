# Nexus Deploy

Railway-inspired deployment for The No Hands Company.

## What it does

- Connect a GitHub repo
- Auto-detect Dockerfiles
- Deploy with persistent volumes
- Store secrets encrypted at rest
- Stream logs in real time

## Local dev

```bash
cp .env.example .env
npm install
npm --prefix web install
npm run dev
```

The app uses `/workspace` for persistent data, which makes it Railway and VPS friendly.

## Environment variables

- `APP_SECRET` - encrypts stored state
- `JWT_SECRET` - signs sessions
- `DATA_DIR` - persistent storage root
- `ALLOW_REGISTRATION` - enable public signups

## Notes

The first admin account is seeded from `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
