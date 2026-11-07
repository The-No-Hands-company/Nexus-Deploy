/**
 * `npm run doctor` — is this node able to run members' apps safely?
 *
 * Static and fast: it looks at the sandbox, not at any app. Exit status 1 if
 * anything failed; warnings do not fail it. `--json` prints the results as JSON.
 */
import { realContext } from "./doctor/context.js";
import { exitCode, formatReport, runChecks, summarize } from "./doctor/run.js";
import { config } from "./lib/config.js";
import { containerLimits } from "./lib/safeguards.js";

const results = await runChecks(realContext(containerLimits({}, config.limits)));
if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify({ ok: exitCode(results) === 0, summary: summarize(results), results }, null, 2),
  );
} else {
  console.log(formatReport(results));
}
process.exit(exitCode(results));
