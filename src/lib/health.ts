// A deployment is only "live" once the app inside it answers. Before this gate
// Deploy flipped to live the moment `docker run -d` returned, so a container
// that crashed on boot was reported live while serving nothing.

/** A declared health path must answer 2xx; without one, any non-5xx response
 *  from `/` proves the process is up and serving. */
export function acceptsStatus(status: number, requireOk: boolean): boolean {
  return requireOk ? status >= 200 && status < 300 : status < 500;
}

export type HealthResult = { ok: true } | { ok: false; reason: string };

export async function waitForHealthy(opts: {
  /** HTTP status of one probe, or null when nothing answered. */
  probe: () => Promise<number | null>;
  isRunning: () => Promise<boolean>;
  requireOk: boolean;
  timeoutMs: number;
  intervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<HealthResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const deadline = now() + opts.timeoutMs;
  let last: number | null = null;
  while (now() < deadline) {
    if (!(await opts.isRunning())) return { ok: false, reason: "container exited before becoming healthy" };
    last = await opts.probe().catch(() => null);
    if (last !== null && acceptsStatus(last, opts.requireOk)) return { ok: true };
    await sleep(opts.intervalMs);
  }
  return {
    ok: false,
    reason: last === null
      ? `app did not answer within ${Math.round(opts.timeoutMs / 1000)}s`
      : `app answered ${last} instead of a healthy status within ${Math.round(opts.timeoutMs / 1000)}s`,
  };
}
