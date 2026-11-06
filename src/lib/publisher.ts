/**
 * How a live app becomes reachable. Deploy decides *that* an app is live on a
 * loopback port; a publisher tells the ingress. Keeping this behind an
 * interface is what lets any node's ingress serve Deploy's apps: on the
 * reference node the publisher registers the route with Nexus Cloud, whose
 * registry the ecosystem proxy reads.
 */
export type PublishedRoute = {
  projectId: string;
  slug: string;
  /** The public hostname, e.g. my-app.<base domain>. */
  host: string;
  /** Loopback port the container is published on. */
  hostPort: number;
};

export interface RoutePublisher {
  /** Point `route.host` at `route.hostPort`, replacing any earlier port for the same slug. */
  publish(route: PublishedRoute): Promise<void>;
  /** Stop serving `slug`. Idempotent. */
  unpublish(slug: string): Promise<void>;
}

/** For a node with no ingress to tell, and for tests that do not care. */
export class NullPublisher implements RoutePublisher {
  async publish(): Promise<void> {}
  async unpublish(): Promise<void> {}
}
