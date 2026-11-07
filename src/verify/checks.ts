import type { FixtureKind, VerifyHarness, VerifyResult, VerifyStep } from "./types.js";

const pass = (detail: string) => ({ status: "pass" as const, detail });
const fail = (detail: string) => ({ status: "fail" as const, detail });

const FIXTURE_KINDS: readonly FixtureKind[] = ["node", "python", "dockerfile", "image"];

const hName = (...parts: string[]) => parts.join("-");
const CF_IP_HEADER = hName("cf", "connecting", "ip");
const XFF_HEADER = hName("x", "forwarded", "for");
const X_REAL_IP_HEADER = hName("x", "real", "ip");

const FORBIDDEN_ECHO_HEADERS = [
  "cookie",
  "authorization",
  CF_IP_HEADER,
  XFF_HEADER,
  X_REAL_IP_HEADER,
  "x-nexus-client-tag",
] as const;

export const VERIFY_STEPS: VerifyStep[] = [
  {
    id: "fixtures-build-and-serve",
    title: "All four generic fixtures build and serve HTTP 200",
    async run(h) {
      const summaries: string[] = [];
      for (const kind of FIXTURE_KINDS) {
        const deployed = await h.deployFixture(kind);
        const res = await h.edgeFetch(deployed.host, "/");
        if (res.status !== 200) {
          return fail(`${kind} (${deployed.host}) answered HTTP ${res.status} instead of 200`);
        }
        summaries.push(`${kind}→${deployed.host}`);
      }
      return pass(summaries.join(", "));
    },
  },
  {
    id: "proxy-strips-sensitive-headers",
    title: "The edge strips cookies, credentials, client IPs and visitor tags",
    needs: ["fixtures-build-and-serve"],
    async run(h) {
      const nodeFixture = h.getFixture("node");
      if (!nodeFixture) return fail("node fixture was not deployed");
      const res = await h.edgeFetch(nodeFixture.host, "/echo", {
        headers: {
          Cookie: "__Secure-nexus-session=secret-cookie",
          Authorization: "Bearer secret-token",
          [CF_IP_HEADER]: "198.51.100.7",
          [XFF_HEADER]: "198.51.100.7",
          [X_REAL_IP_HEADER]: "198.51.100.7",
          "X-Nexus-Client-Tag": "forged-visitor-tag",
        },
      });
      if (res.status !== 200) return fail(`echo probe returned HTTP ${res.status}`);
      let parsed: { headers?: Record<string, unknown> };
      try {
        parsed = JSON.parse(res.body) as { headers?: Record<string, unknown> };
      } catch {
        return fail("fixture did not return valid JSON");
      }
      const received = parsed.headers ?? {};
      const leaked = FORBIDDEN_ECHO_HEADERS.filter((name) => received[name] !== undefined);
      return leaked.length === 0
        ? pass(
            "none of Cookie, Authorization, CF-Connecting-IP or X-Nexus-Client-Tag reached the app",
          )
        : fail(`leaked headers reached the app: ${leaked.join(", ")}`);
    },
  },
  {
    id: "container-network-isolation",
    title: "A running app container cannot reach host loopback or LAN",
    needs: ["fixtures-build-and-serve"],
    async run(h) {
      const nodeFixture = h.getFixture("node");
      if (!nodeFixture) return fail("node fixture was not deployed");
      const probe = await h.probeContainerEgress(nodeFixture.containerName);
      if (probe.loopbackReached) {
        return fail("container reached a listener on the host's loopback (10.0.2.2)");
      }
      if (probe.lanReached) {
        return fail(
          `container reached a listener on the host's LAN (${probe.lanTargets.join(", ")})`,
        );
      }
      return pass(
        `loopback (10.0.2.2) and LAN (${probe.lanTargets.join(", ") || "none"}) unreachable`,
      );
    },
  },
  {
    id: "container-resource-and-log-caps",
    title: "Memory cap (512m) and log caps (10m x 2, local) are enforced",
    needs: ["fixtures-build-and-serve"],
    async run(h) {
      const nodeFixture = h.getFixture("node");
      if (!nodeFixture) return fail("node fixture was not deployed");
      const caps = await h.inspectContainerCaps(nodeFixture.containerName);
      if (caps.memoryMaxBytes !== h.expectedMemoryBytes) {
        return fail(
          `memory.max inside container is ${caps.memoryMaxBytes ?? "unreadable"}, expected ${h.expectedMemoryBytes}`,
        );
      }
      const logOk =
        caps.logDriver === "local" &&
        caps.logMaxSize === "10m" &&
        caps.logMaxFile === "2" &&
        caps.logCompress === "false";
      if (!logOk) {
        return fail(
          `log config is driver=${caps.logDriver} max-size=${caps.logMaxSize} max-file=${caps.logMaxFile} compress=${caps.logCompress}`,
        );
      }
      return pass(`memory.max=${caps.memoryMaxBytes} bytes, logs=local 10m x 2 (<= 20 MB)`);
    },
  },
  {
    id: "short-link-redirect",
    title: "deploy.<domain>/<slug> redirects (302) to https://<slug>.<domain>/",
    needs: ["fixtures-build-and-serve"],
    async run(h) {
      const nodeFixture = h.getFixture("node");
      if (!nodeFixture) return fail("node fixture was not deployed");
      const res = await h.edgeFetch(h.controlHost, `/${nodeFixture.slug}`);
      const location = res.headers["location"] ?? "";
      const expected = `https://${nodeFixture.host}/`;
      return res.status === 302 && location === expected
        ? pass(`302 ${h.controlHost}/${nodeFixture.slug} → ${expected}`)
        : fail(`expected 302 → ${expected}, got ${res.status} → ${location || "(no Location)"}`);
    },
  },
  {
    id: "zero-downtime-unhealthy-and-rollback",
    title: "Blue/green redeploy drops zero requests, rejects an unhealthy revision, and rolls back",
    needs: ["fixtures-build-and-serve"],
    async run(h) {
      const dockerfileFixture = h.getFixture("dockerfile");
      if (!dockerfileFixture) return fail("dockerfile fixture was not deployed");
      const out = await h.exerciseReleaseLifecycle(dockerfileFixture);
      if (out.inFlightFailed > 0 || out.inFlightTotal === 0) {
        return fail(
          `redeploy failed ${out.inFlightFailed} of ${out.inFlightTotal} in-flight requests`,
        );
      }
      if (out.upgradedVersion !== "v2") {
        return fail(`expected upgraded version v2, got ${out.upgradedVersion}`);
      }
      if (out.unhealthyDeploymentStatus !== "failed" || out.versionDuringUnhealthy !== "v2") {
        return fail(
          `unhealthy release ended as ${out.unhealthyDeploymentStatus} while serving ${out.versionDuringUnhealthy}`,
        );
      }
      if (out.rolledBackVersion !== "v1") {
        return fail(`rollback served ${out.rolledBackVersion} instead of v1`);
      }
      return pass(
        `0/${out.inFlightTotal} failed in-flight requests (v1→v2), unhealthy rejected (v2 kept serving), rolled back to v1`,
      );
    },
  },
  {
    id: "volume-persists-across-redeploy",
    title: "A project with a volume keeps its data across a redeploy",
    needs: ["fixtures-build-and-serve"],
    async run(h) {
      const out = await h.exerciseVolumePersistence();
      if (out.readAfterRedeploy !== out.writtenMarker) {
        return fail(
          `volume read '${out.readAfterRedeploy}' after redeploy, expected '${out.writtenMarker}'`,
        );
      }
      if (out.versionAfterRedeploy !== "v2") {
        return fail(`volume project did not advance to v2 (got ${out.versionAfterRedeploy})`);
      }
      return pass(`volume data survived stop-start redeploy to ${out.versionAfterRedeploy}`);
    },
  },
  {
    id: "delete-cleans-everything",
    title: "Deleting the fixture projects removes containers, routes, slugs and volumes",
    needs: ["fixtures-build-and-serve"],
    async run(h) {
      const out = await h.deleteAllFixturesAndVerify();
      const problems: string[] = [];
      if (out.remainingContainers.length > 0) {
        problems.push(`containers: ${out.remainingContainers.join(", ")}`);
      }
      if (out.remainingRoutes.length > 0) {
        problems.push(`routes: ${out.remainingRoutes.join(", ")}`);
      }
      if (out.remainingSlugs.length > 0) {
        problems.push(`slugs: ${out.remainingSlugs.join(", ")}`);
      }
      if (out.remainingVolumes.length > 0) {
        problems.push(`volumes: ${out.remainingVolumes.join(", ")}`);
      }
      return problems.length === 0
        ? pass("all containers, routes, slugs and volumes removed")
        : fail(`leftovers after project deletion: ${problems.join("; ")}`);
    },
  },
];

/**
 * Run every conformance step in order, then always call `harness.cleanup()` in
 * `finally` so no fixture container, image, volume or temporary directory is
 * left behind even when a step fails or throws.
 */
export async function runVerify(
  harness: VerifyHarness,
  steps: readonly VerifyStep[] = VERIFY_STEPS,
): Promise<VerifyResult[]> {
  const results: VerifyResult[] = [];
  const passed = new Set<string>();
  try {
    for (const step of steps) {
      const unmet = (step.needs ?? []).filter((id) => !passed.has(id));
      if (unmet.length > 0) {
        results.push({
          id: step.id,
          title: step.title,
          status: "skip",
          detail: `needs: ${unmet.join(", ")}`,
        });
        continue;
      }
      try {
        const outcome = await step.run(harness);
        results.push({ id: step.id, title: step.title, ...outcome });
        if (outcome.status === "pass") passed.add(step.id);
      } catch (error) {
        results.push({
          id: step.id,
          title: step.title,
          status: "fail",
          detail: `step threw: ${(error as Error).message}`,
        });
      }
    }
  } finally {
    await harness.cleanup();
  }
  return results;
}

const MARK = { pass: "PASS", fail: "FAIL", skip: "SKIP" } as const;

export function formatVerifyReport(results: readonly VerifyResult[]): string {
  const lines = ["nexus-deploy verify", ""];
  for (const r of results) {
    lines.push(`  ${MARK[r.status]}  ${r.title}`);
    lines.push(`        ${r.detail}`);
  }
  const passCount = results.filter((r) => r.status === "pass").length;
  const failCount = results.filter((r) => r.status === "fail").length;
  const skipCount = results.filter((r) => r.status === "skip").length;
  lines.push("", `${passCount} passed, ${failCount} failed, ${skipCount} skipped`);
  return lines.join("\n");
}

export function verifyExitCode(results: readonly VerifyResult[]): number {
  return results.some((r) => r.status !== "pass") ? 1 : 0;
}
