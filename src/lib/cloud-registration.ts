/**
 * Register Deploy itself as an ecosystem tool in Nexus Cloud so it appears
 * in the dashboard grid (https://app.<domain>/) alongside Chat, Draw, Hosting, etc.
 */
import { config } from "./config.js";

function cloudBaseUrl(): string {
  return (
    process.env.NEXUS_CLOUD_INTERNAL_URL ||
    process.env.NEXUS_CLOUD_URL ||
    config.cloudUrl ||
    "http://127.0.0.1:8787"
  )
    .trim()
    .replace(/\/$/, "");
}

function cloudHeaders(): Record<string, string> {
  const key = process.env.NEXUS_CLOUD_API_KEY || "";
  return {
    "content-type": "application/json",
    accept: "application/json",
    ...(key ? { "x-api-key": key } : {}),
  };
}

export function buildDeployRegistrationPayload() {
  return {
    id: "nexus-deploy",
    name: "Nexus Deploy",
    description: "Push-to-deploy platform: connect a repo, auto-build, auto-HTTPS, rollbacks included",
    mode: "orchestrated",
    exposed: true,
    health: "healthy",
    upstreamUrl: `http://127.0.0.1:${config.port}`,
    publicUrl: config.baseUrl,
    delivery: "external",
    capabilities: ["deployment", "ci-cd"],
    metadata: {
      version: "0.6.0",
      defaultPort: config.port,
    },
  };
}

export async function registerDeployWithCloud(): Promise<void> {
  if (!config.cloudUrl) return;
  const res = await fetch(`${cloudBaseUrl()}/api/v1/tools`, {
    method: "POST",
    headers: cloudHeaders(),
    body: JSON.stringify(buildDeployRegistrationPayload()),
  });
  if (!res.ok) {
    throw new Error(`Deploy registration with Cloud failed: ${res.status}`);
  }
}

export async function heartbeatDeployWithCloud(): Promise<void> {
  if (!config.cloudUrl) return;
  const res = await fetch(
    `${cloudBaseUrl()}/api/v1/tools/nexus-deploy/heartbeat`,
    {
      method: "POST",
      headers: cloudHeaders(),
      body: JSON.stringify({ health: "healthy", upstreamUrl: `http://127.0.0.1:${config.port}` }),
    },
  );
  if (!res.ok) {
    throw new Error(`Deploy heartbeat with Cloud failed: ${res.status}`);
  }
}

export function startDeployCloudRegistration(): () => void {
  if (!config.cloudUrl) return () => {};

  registerDeployWithCloud().catch((err) => {
    console.warn(`[nexus-deploy] Cloud registration failed: ${(err as Error).message}`);
  });

  const timer = setInterval(() => {
    heartbeatDeployWithCloud().catch((err) => {
      console.warn(`[nexus-deploy] Cloud heartbeat failed: ${(err as Error).message}`);
    });
  }, 30_000);
  if (typeof timer.unref === "function") timer.unref();

  return () => clearInterval(timer);
}
