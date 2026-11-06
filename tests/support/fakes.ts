import type { PublishedRoute, RoutePublisher } from "../../src/lib/publisher.js";
import type { ContainerSpec, ReleaseDeps, ReleaseRuntime } from "../../src/lib/release.js";

/** Records every call in order, so a test can assert what happened *before* what. */
export class FakeRuntime implements ReleaseRuntime {
  readonly calls: string[] = [];
  readonly specs: ContainerSpec[] = [];
  private readonly alive = new Set<string>();
  /** Status each probe on a port returns, in order; the last one repeats. */
  probes = new Map<number, Array<number | null>>();
  failRun = new Set<string>();
  tails = new Map<string, string[]>();

  async run(spec: ContainerSpec): Promise<string> {
    this.calls.push(`run:${spec.name}:${spec.hostPort}`);
    this.specs.push(spec);
    if (this.failRun.has(spec.name)) throw new Error("port is already allocated");
    this.alive.add(spec.name);
    return `id-${spec.name}`;
  }

  async probe(hostPort: number): Promise<number | null> {
    this.calls.push(`probe:${hostPort}`);
    const queue = this.probes.get(hostPort) ?? [200];
    return queue.length > 1 ? (queue.shift() as number | null) : (queue[0] ?? null);
  }

  async status(name: string): Promise<string> {
    return this.alive.has(name) ? "running" : "missing";
  }

  async logTail(name: string): Promise<string[]> {
    return this.tails.get(name) ?? [];
  }

  async remove(name: string): Promise<void> {
    this.calls.push(`remove:${name}`);
    this.alive.delete(name);
  }

  isAlive(name: string): boolean {
    return this.alive.has(name);
  }

  /** Pretend this container was already running before the release began. */
  seed(name: string): void {
    this.alive.add(name);
  }
}

export class RecordingPublisher implements RoutePublisher {
  readonly published: PublishedRoute[] = [];
  readonly unpublished: string[] = [];
  readonly log: string[];
  fail = false;

  constructor(log: string[] = []) {
    this.log = log;
  }

  async publish(route: PublishedRoute): Promise<void> {
    if (this.fail) throw new Error("cloud unreachable");
    this.log.push(`publish:${route.hostPort}`);
    this.published.push(route);
  }

  async unpublish(slug: string): Promise<void> {
    this.log.push(`unpublish:${slug}`);
    this.unpublished.push(slug);
  }
}

/** A clock that only moves when something sleeps, so timeouts take no real time. */
export function fakeClock() {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

export function makeDeps(
  runtime: FakeRuntime,
  publisher: RecordingPublisher,
  ports: number[],
): ReleaseDeps & {
  clock: ReturnType<typeof fakeClock>;
  logs: string[];
} {
  const clock = fakeClock();
  const logs: string[] = [];
  return {
    runtime,
    publisher,
    allocatePort: async () => ports.shift() ?? 29999,
    health: { timeoutMs: 5_000, intervalMs: 500, now: clock.now, sleep: clock.sleep },
    drainMs: 10_000,
    sleep: clock.sleep,
    log: (line) => logs.push(line),
    clock,
    logs,
  };
}
