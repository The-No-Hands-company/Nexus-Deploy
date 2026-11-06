import type { Project } from "../types.js";
import { CloudPublisher, type CloudSettings, makeTakenElsewhere } from "./cloud.js";
/**
 * How this node's ingress is told about apps, assembled from configuration.
 *
 * Cloud and Hosting are both optional: a node with neither announces nothing and
 * only checks names against its own projects. A node with Cloud must have its
 * credential, so a half-configured node refuses to start instead of silently
 * running apps nobody can reach.
 */
import { appHost } from "./hosts.js";
import { NullPublisher, type PublishedRoute, type RoutePublisher } from "./publisher.js";

export type EdgeSettings = {
  cloudUrl: string;
  cloudUserAppsKey: string;
  cloudTimeoutMs: number;
  cloudHeartbeatMs: number;
  hostingSiteUrl: string;
  baseDomain: string;
  appHostPattern: string;
};

export type Edge = {
  publisher: RoutePublisher;
  /** For checkSlug: is the name used outside Deploy? Throws when it cannot be checked. */
  takenElsewhere: (slug: string) => Promise<boolean>;
  /** Announce the apps that were live before this process started, then keep them announced. */
  start: () => Promise<void>;
  stop: () => void;
};

/** The routes for every project that is serving now. */
export function liveRoutes(projects: readonly Project[], settings: EdgeSettings): PublishedRoute[] {
  return projects.flatMap((project) =>
    project.status === "live" && project.hostPort !== undefined
      ? [
          {
            projectId: project.id,
            slug: project.name,
            host: appHost(project.name, settings.appHostPattern, settings.baseDomain),
            hostPort: project.hostPort,
          },
        ]
      : [],
  );
}

export function createEdge(settings: EdgeSettings, loadProjects: () => readonly Project[]): Edge {
  const hostOf = (slug: string) => appHost(slug, settings.appHostPattern, settings.baseDomain);

  let cloud: CloudSettings | undefined;
  let publisher: RoutePublisher = new NullPublisher();
  let cloudPublisher: CloudPublisher | undefined;
  if (settings.cloudUrl) {
    cloud = {
      url: settings.cloudUrl,
      key: settings.cloudUserAppsKey,
      timeoutMs: settings.cloudTimeoutMs,
    };
    cloudPublisher = new CloudPublisher(cloud);
    publisher = cloudPublisher;
  }

  return {
    publisher,
    takenElsewhere: makeTakenElsewhere({
      ...(cloud ? { cloud } : {}),
      ...(settings.hostingSiteUrl ? { hostingSiteUrl: settings.hostingSiteUrl } : {}),
      hostOf,
      timeoutMs: settings.cloudTimeoutMs,
    }),
    async start() {
      if (!cloudPublisher) return;
      const failed = await cloudPublisher.restore(liveRoutes(loadProjects(), settings));
      if (failed > 0) console.warn(`[edge] ${failed} live app(s) could not be announced to Cloud`);
      cloudPublisher.start(settings.cloudHeartbeatMs, (slug) =>
        loadProjects().some((p) => p.name === slug && p.status === "live"),
      );
    },
    stop() {
      cloudPublisher?.stop();
    },
  };
}
