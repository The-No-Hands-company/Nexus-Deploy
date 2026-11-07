# ⬡ Nexus Deploy

**Self-hosted deployment platform by [The No Hands Company](https://github.com/The-No-Hands-company)**

Deploy a Git repository or a container image and get a live HTTPS app. A free, open-source alternative to paid deployment platforms such as Railway and Render, for anyone to run or use.

---

## 💸 Pricing

**Free. Always. No exceptions.** Nexus Deploy is part of [The No Hands Company](https://github.com/The-No-Hands-company)'s promise that nothing it makes is sold or put behind a paywall. The software contains no billing or plans. Safeguards that protect a shared node (CPU, memory and build limits) apply equally to everyone and are shown in the dashboard. Anyone running their own node may charge for it; the licence allows that.

---

## ✨ Features (v0.6 Foundation)

| Feature | Details |
|---|---|
| **Git & OCI Image sources** | Deploy any public or private Git repository (via askpass token) or any OCI container image |
| **Auto-detect runtime** | [Railpack](https://railpack.com) (`v0.43.0`) builds Node, Python, Go, Rust, etc. via rootless BuildKit; uses `Dockerfile` when present |
| **Blue/green releases** | Starts the new container on a free loopback port, probes health, switches the live route, and drains the old container with zero downtime |
| **Rootless sandbox daemon** | Runs builds and containers inside a dedicated unprivileged user's rootless Docker daemon on a size-capped XFS loop filesystem |
| **Container hardening** | Drops all Linux capabilities (`--cap-drop ALL`), sets `no-new-privileges`, enforces memory/CPU/PID caps, blocks host loopback/LAN egress, and caps container logs at 20 MB |
| **Zero visitor tracking** | Edge proxy strips visitor IPs, cookies, credentials, and client tags before requests reach deployed apps |
| **Instant rollback** | Re-deploy any previous image or pinned `@sha256` digest with one click |
| **Data ownership** | Export portable project JSON (`GET /api/projects/:id/export`), delete individual build logs, or delete a project and every artifact it created |

---

## 🏗️ Architecture

```
Git push (HMAC webhook) or Manual / Image deploy
  ↓
Nexus Deploy Control Plane (Express + TypeScript + WebSocket/SSE)
  ↓ SANDBOX_DOCKER_HOST (never the host daemon)
Rootless Docker Sandbox (dedicated user, size-capped XFS loop image, nftables egress filter)
  ├─ Builder: Dockerfile or Railpack v0.43.0 (BuildKit frontend)
  └─ Runtime: 127.0.0.1:<port in 20000-29999> (--cap-drop ALL, 512 MB, 0.5 CPU, 256 PIDs, 10m×2 logs)
  ↓ Health probe passes
Nexus Cloud Route Registry (/api/v1/user-apps/:slug, userDeployed=true)
  ↓
Ecosystem Reverse Proxy (cookie/credential/IP/tag isolation + deploy.<domain>/<slug> short link)
  ↓
https://<slug>.<base-domain>
```

---

## 🚀 Node Bring-Up

### 1. Provision the rootless sandbox (requires `sudo` once)

```bash
sudo bash sandbox/setup.sh --deploy-user "$USER"
```

This creates the unprivileged `nexus-deploy` user, allocates a size-capped XFS loop image (`/var/lib/nexus-deploy-sandbox.img`), starts the rootless Docker daemon with `local` log caps (`10m` × 2 files), grants your service user group access to its socket, and installs the `nftables` host-loopback/LAN egress filter.

### 2. Install the Railpack builder

```bash
bash sandbox/install-builder.sh
```

Installs pinned `railpack v0.43.0` (SHA-256 verified) to `~/.local/bin/railpack`.

### 3. Build and check readiness

```bash
npm install
npm --prefix web install
npm run build
./check.sh
npm run doctor
```

### 4. Run end-to-end conformance verification

```bash
SANDBOX_DOCKER_HOST="unix:///run/user/$(id -u nexus-deploy)/docker.sock" \
SANDBOX_STORAGE_PATH="/var/lib/nexus-deploy-sandbox" \
npm run verify
```

---

## 📄 License

[GNU AGPL-3.0](LICENSE). Fork it, change it, run it; if you offer a changed version to others as a service, share your changes too.
