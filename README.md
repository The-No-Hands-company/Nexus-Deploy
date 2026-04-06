# ⬡ Nexus Deploy

**Self-hosted deployment platform by [The No Hands Company](https://github.com/The-No-Hands-company)**

Push to GitHub → auto-build → live HTTPS app. Your own Railway, on your own server.

---

## 💸 Pricing

**Free. Always. No exceptions.**

Nexus Deploy is and will always be 100% free. The No Hands Company does not bill users for any of its products. [Donations welcome](https://github.com/The-No-Hands-company) — never required.

---

## ✨ Features

| Feature | Details |
|---|---|
| **Push-to-deploy** | GitHub webhooks trigger builds on every push |
| **Auto-detect runtime** | Nixpacks for Node/Python/Go/Ruby; falls back to Dockerfile if present |
| **Automatic HTTPS** | Traefik + Let's Encrypt, zero config |
| **Live log streaming** | Watch builds and containers stream in real time via WebSocket |
| **Rollback** | Re-deploy any previous image with one click |
| **Env vars** | Encrypted at rest (AES-256-GCM), injected at runtime |
| **Status sync** | Background job corrects DB when containers crash or restart |
| **Build lock** | Prevents concurrent builds on the same project |
| **No vendor lock-in** | Runs on any VPS with Docker. Owns your data. |

---

## 🏗️ Architecture

```
GitHub push
  ↓ POST /api/webhooks/github/:projectId  (HMAC verified)
Nexus Deploy API  (Express + TypeScript + WebSocket)
  ↓ git clone → nixpacks build / docker build
Docker image
  ↓ docker run --network nexus-net
Traefik  (auto SSL + subdomain routing)
  ↓
https://your-app.deploy.yourdomain.com
```

**Stack:** Node.js · TypeScript · Express · WebSocket · AES-GCM encrypted JSON DB · React · Vite · Traefik

---

## 🚀 Self-Host in 5 Minutes

### Prerequisites
- VPS or server with Docker + Docker Compose installed
- Domain pointed at your server (`A` record for `*.deploy.yourdomain.com` and `deploy.yourdomain.com`)
- Port 80 and 443 open

### 1. Clone

```bash
git clone https://github.com/The-No-Hands-company/Nexus-Deploy
cd Nexus-Deploy
cp .env.example .env
```

### 2. Configure

Edit `.env`:

```env
BASE_URL=https://deploy.yourdomain.com
BASE_DOMAIN=deploy.yourdomain.com
ACME_EMAIL=you@youremail.com

# Generate with: openssl rand -hex 32
JWT_SECRET=your_random_64_char_string
APP_SECRET=another_random_64_char_string

ADMIN_EMAIL=you@yourdomain.com
ADMIN_PASSWORD=choose_a_strong_password
```

### 3. Install Nixpacks (on the host)

```bash
curl -sSL https://nixpacks.com/install.sh | bash
```

> Nixpacks auto-detects your app's runtime — Node, Python, Go, Ruby, etc. If your repo has a `Dockerfile`, that's used instead.

### 4. Launch

```bash
docker compose up -d
```

Dashboard is live at `https://deploy.yourdomain.com` once DNS propagates and SSL issues. ✅

---

## 📖 Usage

### Create a project

1. Open the dashboard → **New project**
2. Enter your GitHub repo (e.g. `owner/repo` or full HTTPS URL)
3. Set branch, port your app listens on, env vars
4. Click **Deploy**

### Set up auto-deploy (GitHub webhook)

1. In the dashboard → your project → **⚡ Webhook** tab
2. Copy the **Payload URL** and **Secret**
3. Go to your GitHub repo → **Settings → Webhooks → Add webhook**
   - Payload URL: paste it
   - Content type: `application/json`
   - Secret: paste it
   - Events: **Just the push event**
4. Done — every `git push` now auto-deploys 🎉

### Rollback

In the **Overview** tab, every successful deployment has a **↩** button. Click it to instantly re-run that image — no rebuild needed.

### Environment variables

**⚙ Environment** tab — add key/value pairs, click Save. Redeploy to apply.

---

## 🗺️ Roadmap

- [x] v0.1 — Core scaffold, auth, projects, deployments, basic dashboard
- [x] v0.2 — Real build engine (Nixpacks + Docker), WebSocket logs, rollback, webhook panel, status sync, activity feed, write-safe store, build lock
- [ ] v0.3 — Custom domains, deploy previews, health checks with alerting
- [ ] v0.4 — Multi-user teams, deploy hooks, scheduled deploys
- [ ] v0.5 — Federation with Nexus Hosting nodes

---

## 🛠️ Local Development

```bash
# Install
npm install
npm --prefix web install

# Dev (tsx watch + vite HMR)
npm run dev

# Build
npm run build

# Type check
npm run typecheck
```

The app stores data in `DATA_DIR` (default `/workspace`). In dev it creates `./workspace`.

---

## 🤝 Part of the Nexus Ecosystem

- **[Nexus Hosting](https://github.com/The-No-Hands-company)** — Federated website hosting
- **Nexus Deploy** — Self-hosted deployment engine ← you are here

---

## 📄 License

MIT — fork it, own it, run it.

---

*Built with ❤️ by The No Hands Company. No hands. All heart.*
