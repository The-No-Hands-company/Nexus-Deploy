import { CHECKS } from "./checks.js";
import type { Check, CheckResult, Ctx } from "./types.js";

/** Run every check in order. A check whose prerequisites did not pass is skipped, not failed. */
export async function runChecks(
  ctx: Ctx,
  checks: readonly Check[] = CHECKS,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const passed = new Set<string>();
  for (const check of checks) {
    const unmet = (check.needs ?? []).filter((id) => !passed.has(id));
    if (unmet.length > 0) {
      results.push({
        id: check.id,
        title: check.title,
        status: "skip",
        detail: `needs: ${unmet.join(", ")}`,
      });
      continue;
    }
    let outcome: Awaited<ReturnType<Check["run"]>>;
    try {
      outcome = await check.run(ctx);
    } catch (error) {
      outcome = { status: "fail", detail: `the check itself failed: ${(error as Error).message}` };
    }
    results.push({ id: check.id, title: check.title, ...outcome });
    if (outcome.status === "pass") passed.add(check.id);
  }
  return results;
}

export function summarize(results: readonly CheckResult[]) {
  const count = (s: CheckResult["status"]) => results.filter((r) => r.status === s).length;
  return {
    passed: count("pass"),
    warnings: count("warn"),
    failed: count("fail"),
    skipped: count("skip"),
  };
}

const MARK = { pass: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" } as const;

export function formatReport(results: readonly CheckResult[]): string {
  const lines = ["nexus-deploy doctor", ""];
  for (const r of results) {
    lines.push(`  ${MARK[r.status]}  ${r.title}`);
    lines.push(`        ${r.detail}`);
    if (r.fix && (r.status === "fail" || r.status === "warn")) lines.push(`        fix: ${r.fix}`);
  }
  const s = summarize(results);
  lines.push(
    "",
    `${s.passed} passed, ${s.failed} failed, ${s.warnings} warnings, ${s.skipped} skipped`,
  );
  return lines.join("\n");
}

export function exitCode(results: readonly CheckResult[]): number {
  return results.some((r) => r.status === "fail") ? 1 : 0;
}
