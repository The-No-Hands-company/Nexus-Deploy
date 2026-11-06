/**
 * Telling the ingress about live apps, and asking whether a name is free.
 *
 * On the reference node the ingress reads Nexus Cloud's registry, so announcing
 * an app means registering it there. Cloud, not this server, decides how the
 * route is treated: it marks it as a member's app, which the proxy isolates.
 */
import http from "node:http";
import type { PublishedRoute, RoutePublisher } from "./publisher.js";

export type CloudSettings = {
  /** Cloud's internal address, e.g. http://127.0.0.1:8787. */
  url: string;
  /** The user-apps credential. */
  key: string;
  timeoutMs: number;
};

export class CloudError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CloudError";
  }
}

function endpoint(settings: CloudSettings, slug: string, suffix = ""): string {
  return `${settings.url.replace(/\/+$/, "")}/api/v1/user-apps/${encodeURIComponent(slug)}${suffix}`;
}

async function request(
  settings: CloudSettings,
  method: string,
  url: string,
  body?: unknown,
): Promise<Response> {
  try {
    return await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${settings.key}`,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
  } catch (error) {
    throw new CloudError(`Cloud could not be reached: ${(error as Error).message}`);
  }
}

/** Registers each live app with Cloud and keeps the registration fresh. */
export class CloudPublisher implements RoutePublisher {
  private readonly live = new Map<string, PublishedRoute>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly settings: CloudSettings) {
    if (!settings.url) throw new Error("CLOUD_URL is required to publish routes");
    if (!settings.key) throw new Error("CLOUD_USER_APPS_KEY is required when CLOUD_URL is set");
  }

  async publish(route: PublishedRoute): Promise<void> {
    const res = await request(this.settings, "PUT", endpoint(this.settings, route.slug), {
      upstreamUrl: `http://127.0.0.1:${route.hostPort}`,
    });
    if (res.status === 409) {
      throw new CloudError(`"${route.slug}" is already in use on this node`, 409);
    }
    if (!res.ok) throw new CloudError(`Cloud refused the route (HTTP ${res.status})`, res.status);
    this.live.set(route.slug, route);
  }

  async unpublish(slug: string): Promise<void> {
    this.live.delete(slug);
    const res = await request(this.settings, "DELETE", endpoint(this.settings, slug));
    // Already gone is the state we wanted.
    if (res.status !== 204 && res.status !== 404) {
      throw new CloudError(`Cloud could not remove the route (HTTP ${res.status})`, res.status);
    }
  }

  /** Announce routes that were live before this process started. */
  async restore(routes: readonly PublishedRoute[]): Promise<number> {
    let failed = 0;
    for (const route of routes) {
      try {
        await this.publish(route);
      } catch (error) {
        failed++;
        console.warn(`[cloud] could not restore ${route.slug}: ${(error as Error).message}`);
      }
    }
    return failed;
  }

  /**
   * Re-announce every route that is still live, and remove the ones that are
   * not, so a stopped app stops being routed instead of lingering until Cloud
   * times it out. Returns how many announcements failed.
   */
  async refresh(isLive: (slug: string) => boolean): Promise<number> {
    let failed = 0;
    for (const route of [...this.live.values()]) {
      try {
        if (isLive(route.slug)) await this.publish(route);
        else await this.unpublish(route.slug);
      } catch (error) {
        failed++;
        console.warn(`[cloud] ${route.slug}: ${(error as Error).message}`);
      }
    }
    return failed;
  }

  start(intervalMs: number, isLive: (slug: string) => boolean): void {
    this.stop();
    this.timer = setInterval(() => void this.refresh(isLive), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** Does Cloud already route this name? Throws when it cannot be answered. */
export async function cloudNameTaken(settings: CloudSettings, slug: string): Promise<boolean> {
  const res = await request(settings, "GET", endpoint(settings, slug, "/availability"));
  if (!res.ok)
    throw new CloudError(`Cloud could not check the name (HTTP ${res.status})`, res.status);
  const body = (await res.json().catch(() => null)) as { taken?: unknown } | null;
  if (typeof body?.taken !== "boolean") throw new CloudError("Cloud gave an unreadable answer");
  return body.taken;
}

/**
 * Does a Hosting site already answer for this host?
 *
 * Hosting's site-proxy dispatches on the Host header and answers an unknown name
 * with a 404 page that says "No site found". Anything else, including a 404 that
 * does not say it, means a site is there. Errors and 5xx throw: if we cannot tell,
 * the name is not given out.
 */
export function hostingNameTaken(
  siteUrl: string,
  host: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const target = new URL(siteUrl);
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: "/",
        method: "GET",
        headers: { host },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.length < 64 && chunks.push(c));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status >= 500)
            return reject(new CloudError(`Hosting answered HTTP ${status}`, status));
          const body = Buffer.concat(chunks).toString("utf8");
          resolve(!(status === 404 && body.includes("No site found")));
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("Hosting did not answer in time")));
    req.on("error", reject);
    req.end();
  });
}

export type NameCheckSettings = {
  cloud?: CloudSettings;
  hostingSiteUrl?: string;
  /** slug → public host, from APP_HOST_PATTERN. */
  hostOf: (slug: string) => string;
  timeoutMs: number;
};

/**
 * "Is this name used outside Deploy?" — the answer for checkSlug's takenElsewhere.
 * Asks every configured neighbour. If any cannot be asked, this throws.
 */
export function makeTakenElsewhere(
  settings: NameCheckSettings,
): (slug: string) => Promise<boolean> {
  return async (slug) => {
    const checks: Promise<boolean>[] = [];
    if (settings.cloud) checks.push(cloudNameTaken(settings.cloud, slug));
    if (settings.hostingSiteUrl) {
      checks.push(
        hostingNameTaken(settings.hostingSiteUrl, settings.hostOf(slug), settings.timeoutMs),
      );
    }
    const answers = await Promise.all(checks);
    return answers.some(Boolean);
  };
}
