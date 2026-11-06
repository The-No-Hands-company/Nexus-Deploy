import { dockerLogTail, dockerRemove, dockerRunHardened, dockerStatus } from "./docker.js";
import { probeLoopback } from "./health.js";
import type { ReleaseRuntime } from "./release.js";

/** The real runtime: everything goes to the sandbox daemon through docker.ts. */
export const dockerReleaseRuntime: ReleaseRuntime = {
  run: (spec, onLine) =>
    dockerRunHardened({
      name: spec.name,
      image: spec.image,
      env: spec.env,
      appPort: spec.appPort,
      hostPort: spec.hostPort,
      limits: spec.limits,
      volume: spec.volume,
      onLine,
    }),
  probe: (hostPort, path) => probeLoopback(hostPort, path),
  status: (name) => dockerStatus(name),
  logTail: (name) => dockerLogTail(name),
  remove: (name) => dockerRemove(name),
};
