/**
 * `npm run verify`: end-to-end conformance test for Nexus Deploy (Spec §12).
 *
 * Builds and runs the four generic fixture apps (Node, Python, Dockerfile and
 * an image reference) against the real rootless sandbox daemon, exercises header
 * stripping, container network isolation, cgroup memory & log caps, the short
 * link redirect, blue/green zero-downtime redeploy, unhealthy release rejection,
 * rollback, volume persistence and project deletion, then removes all test
 * resources. Exits 1 if any conformance check fails.
 */
import { formatVerifyReport, runVerify, verifyExitCode } from "./verify/checks.js";
import { createLiveHarness } from "./verify/live-harness.js";

const harness = await createLiveHarness();
const results = await runVerify(harness);
console.log(formatVerifyReport(results));
process.exit(verifyExitCode(results));
