import { isolationArgs } from "../lib/run-args.js";
import type { Check, Ctx } from "./types.js";

/** Paths where the host's own Docker daemon listens. The sandbox must never be one of them. */
const HOST_DAEMON_SOCKETS = new Set(["/var/run/docker.sock", "/run/docker.sock"]);

/** How a slirp4netns container addresses the host's loopback (disabled in the sandbox). */
const SLIRP_HOST_LOOPBACK = "10.0.2.2";

const GB = 1024 * 1024 * 1024;

const pass = (detail: string) => ({ status: "pass" as const, detail });
const fail = (detail: string, fix?: string) => ({
  status: "fail" as const,
  detail,
  ...(fix ? { fix } : {}),
});
const warn = (detail: string, fix?: string) => ({
  status: "warn" as const,
  detail,
  ...(fix ? { fix } : {}),
});

const RERUN_SETUP = "Run sandbox/setup.sh again (see apps/Nexus-Deploy/sandbox/setup.sh --help).";

function socketPathOf(host: string): string | null {
  return host.startsWith("unix://") ? host.slice("unix://".length) : null;
}

/** A container that runs `script` under the real isolation flags and is removed afterwards. */
async function probe(ctx: Ctx, script: string, extra: string[] = []) {
  return ctx.docker(
    ["run", "--rm", ...isolationArgs(ctx.limits), ...extra, ctx.probeImage, "sh", "-c", script],
    60_000,
  );
}

/** Can a container reach `host:port`, judged by whether our listener saw it connect? */
async function containerReaches(ctx: Ctx, listenOn: string, targetHost: string): Promise<boolean> {
  const listener = await ctx.listen(listenOn);
  try {
    await probe(ctx, `echo hello | nc -w 3 ${targetHost} ${listener.port} >/dev/null 2>&1; true`);
    return listener.accepted() > 0;
  } finally {
    listener.close();
  }
}

export const CHECKS: Check[] = [
  {
    id: "sandbox-configured",
    title: "The sandbox daemon is configured",
    async run(ctx) {
      if (!ctx.sandboxHost) {
        return fail(
          "SANDBOX_DOCKER_HOST is empty, so Deploy refuses to build or run anything.",
          "Set SANDBOX_DOCKER_HOST to the socket printed by sandbox/setup.sh.",
        );
      }
      const socket = socketPathOf(ctx.sandboxHost);
      if (socket && HOST_DAEMON_SOCKETS.has(socket)) {
        return fail(
          `SANDBOX_DOCKER_HOST points at the host's own Docker daemon (${socket}).`,
          "Point it at the sandbox daemon, never the host's.",
        );
      }
      if (socket && !ctx.fileExists(socket)) {
        return fail(`The socket ${socket} does not exist.`, RERUN_SETUP);
      }
      return pass(ctx.sandboxHost);
    },
  },
  {
    id: "sandbox-daemon",
    title: "The sandbox daemon answers",
    needs: ["sandbox-configured"],
    async run(ctx) {
      const res = await ctx.docker(["info", "--format", "{{json .}}"], 20_000);
      if (res.code !== 0) {
        return fail(`docker info failed: ${res.stderr.trim().split("\n")[0] ?? ""}`, RERUN_SETUP);
      }
      try {
        const info = JSON.parse(res.stdout) as { ServerVersion?: string };
        return pass(`Docker ${info.ServerVersion ?? "(unknown version)"}`);
      } catch {
        return fail("docker info gave an unreadable answer.");
      }
    },
  },
  {
    id: "sandbox-rootless",
    title: "The daemon is rootless",
    needs: ["sandbox-daemon"],
    async run(ctx) {
      const res = await ctx.docker(["info", "--format", "{{json .SecurityOptions}}"], 20_000);
      const options = res.stdout;
      return res.code === 0 && options.includes("name=rootless")
        ? pass("name=rootless is among the daemon's security options")
        : fail(
            "The daemon is not rootless: a container escape would be root on this machine.",
            RERUN_SETUP,
          );
    },
  },
  {
    id: "sandbox-probe-image",
    title: "The probe image is available",
    needs: ["sandbox-daemon"],
    async run(ctx) {
      const have = await ctx.docker(["image", "inspect", ctx.probeImage], 20_000);
      if (have.code === 0) return pass(ctx.probeImage);
      const pulled = await ctx.docker(["pull", "-q", ctx.probeImage], 120_000);
      return pulled.code === 0
        ? pass(`${ctx.probeImage} (pulled)`)
        : fail(
            `Could not pull ${ctx.probeImage}: ${pulled.stderr.trim().split("\n")[0] ?? ""}`,
            "The sandbox needs outbound access to a registry; check DNS and the egress filter.",
          );
    },
  },
  {
    id: "sandbox-log-caps",
    title: "Container logs are size-capped",
    needs: ["sandbox-probe-image"],
    async run(ctx) {
      const name = `nexus-doctor-${process.pid}-${Date.now()}`;
      const made = await ctx.docker(
        ["create", "--name", name, ...isolationArgs(ctx.limits), ctx.probeImage, "true"],
        30_000,
      );
      if (made.code !== 0) return fail(`Could not create a test container: ${made.stderr.trim()}`);
      try {
        const res = await ctx.docker(
          ["inspect", "--format", "{{json .HostConfig.LogConfig}}", name],
          20_000,
        );
        const cfg = JSON.parse(res.stdout) as { Type?: string; Config?: Record<string, string> };
        const c = cfg.Config ?? {};
        const ok =
          cfg.Type === "local" &&
          c["max-size"] === "10m" &&
          c["max-file"] === "2" &&
          c["compress"] === "false";
        return ok
          ? pass("local driver, 10m x 2 files, no compression")
          : fail(
              `Logs are not capped as the Charter requires (${res.stdout.trim()}).`,
              "The run flags carry the caps; if this fails the daemon is overriding them.",
            );
      } finally {
        await ctx.docker(["rm", "-f", name], 20_000);
      }
    },
  },
  {
    id: "sandbox-hardening",
    title: "Containers get no capabilities and cannot gain any",
    needs: ["sandbox-probe-image"],
    async run(ctx) {
      const res = await probe(ctx, "grep -E '^(CapEff|NoNewPrivs):' /proc/self/status");
      const capEff = /CapEff:\s*([0-9a-f]+)/.exec(res.stdout)?.[1];
      const noNewPrivs = /NoNewPrivs:\s*(\d)/.exec(res.stdout)?.[1];
      if (res.code !== 0 || capEff === undefined || noNewPrivs === undefined) {
        return fail(`Could not read the container's privileges: ${res.stderr.trim()}`);
      }
      return /^0+$/.test(capEff) && noNewPrivs === "1"
        ? pass(`CapEff=${capEff}, NoNewPrivs=1`)
        : fail(`CapEff=${capEff}, NoNewPrivs=${noNewPrivs}: the flags are not taking effect.`);
    },
  },
  {
    id: "sandbox-storage",
    title: "The sandbox has its own size-capped filesystem",
    async run(ctx) {
      if (!ctx.storagePath) {
        return fail(
          "SANDBOX_STORAGE_PATH is empty.",
          "Set it to the mount printed by sandbox/setup.sh.",
        );
      }
      const own = ctx.device(ctx.storagePath);
      const parent = ctx.device(`${ctx.storagePath}/..`);
      if (own === null) return fail(`${ctx.storagePath} does not exist.`, RERUN_SETUP);
      if (own === parent) {
        return fail(
          `${ctx.storagePath} is on the same filesystem as its parent, so a runaway build can fill that disk.`,
          RERUN_SETUP,
        );
      }
      const usage = ctx.fsUsage(ctx.storagePath);
      if (!usage) return fail(`Could not read the size of ${ctx.storagePath}.`);
      const gb = usage.totalBytes / GB;
      const detail = `${gb.toFixed(1)} GB, ${((usage.freeBytes / usage.totalBytes) * 100).toFixed(0)}% free`;
      if (ctx.expectedStorageGb > 0 && gb > ctx.expectedStorageGb * 1.05) {
        return fail(
          `${detail}: larger than the configured ${ctx.expectedStorageGb} GB cap.`,
          RERUN_SETUP,
        );
      }
      return usage.freeBytes / usage.totalBytes < 0.15
        ? warn(
            `${detail}: builds will pause at 85% used.`,
            "Prune images or enlarge the storage image.",
          )
        : pass(detail);
    },
  },
  {
    id: "sandbox-no-host-loopback",
    title: "Containers cannot reach the host's loopback services",
    needs: ["sandbox-probe-image"],
    async run(ctx) {
      return (await containerReaches(ctx, "127.0.0.1", SLIRP_HOST_LOOPBACK))
        ? fail(
            "A container reached a service listening on the host's loopback (Auth, Cloud and the databases live there).",
            "The daemon must run with DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=true. " +
              RERUN_SETUP,
          )
        : pass("a loopback listener on the host was unreachable from a container");
    },
  },
  {
    id: "sandbox-no-lan",
    title: "Containers cannot reach this machine or the LAN",
    needs: ["sandbox-probe-image"],
    async run(ctx) {
      const addresses = ctx.hostAddresses();
      if (addresses.length === 0)
        return warn("This machine has no non-loopback IPv4 address to test.");
      const reached: string[] = [];
      for (const address of addresses) {
        if (await containerReaches(ctx, "0.0.0.0", address)) reached.push(address);
      }
      return reached.length === 0
        ? pass(`unreachable via ${addresses.join(", ")}`)
        : fail(
            `A container reached a host service through ${reached.join(", ")}. Any service this machine binds to all interfaces is open to members' code.`,
            "The egress filter is missing or stale. " + RERUN_SETUP,
          );
    },
  },
  {
    id: "sandbox-dns",
    title: "Containers can still resolve names",
    needs: ["sandbox-probe-image"],
    async run(ctx) {
      const res = await probe(ctx, "nslookup example.com 2>&1 | grep -c Address");
      const count = Number(res.stdout.trim().split("\n").pop());
      return res.code === 0 && count > 0
        ? pass("example.com resolved from inside a container")
        : fail(
            "A container could not resolve a name, so builds will fail to fetch dependencies.",
            "The egress filter must allow the machine's resolvers; resolvers change. " +
              RERUN_SETUP,
          );
    },
  },
  {
    id: "builder-installed",
    title: "The builder (Railpack) is installed",
    async run(ctx) {
      const res = await ctx.builder(["--version"], 10_000);
      const version = res.stdout.trim().split("\n")[0] ?? "";
      return res.code === 0 && /railpack/i.test(version)
        ? pass(version)
        : fail(
            `Railpack is missing or could not run (${(res.stderr || res.stdout).trim().split("\n")[0] || `exit ${res.code}`}).`,
            "Run bash sandbox/install-builder.sh to install Railpack into ~/.local/bin.",
          );
    },
  },
  {
    id: "cloud-registration",
    title: "Cloud route registration is ready",
    async run(ctx) {
      if (!ctx.cloudUrl) {
        return warn(
          "CLOUD_URL is empty; live routes will not be announced to Nexus Cloud (standalone mode).",
          "Set CLOUD_URL and NEXUS_CLOUD_USER_APPS_KEY to publish routes through Nexus Cloud.",
        );
      }
      if (!ctx.cloudUserAppsKey) {
        return fail(
          "NEXUS_CLOUD_USER_APPS_KEY is empty while CLOUD_URL is set, so route publishing will fail.",
          "Set NEXUS_CLOUD_USER_APPS_KEY in both Cloud's and Deploy's .env files.",
        );
      }
      const res = await ctx.probeCloud();
      return res.ok
        ? pass(res.detail)
        : fail(
            `Cloud rejected or did not answer the route-registration probe: ${res.detail}`,
            "Check that Nexus Cloud is running at CLOUD_URL and has the same NEXUS_CLOUD_USER_APPS_KEY.",
          );
    },
  },
  {
    id: "wildcard-domain",
    title: "The wildcard domain resolves",
    async run(ctx) {
      if (!ctx.baseDomain) {
        return fail("BASE_DOMAIN is empty.", "Set BASE_DOMAIN in .env (for example example.test).");
      }
      if (ctx.baseDomain === "localhost" || ctx.baseDomain.endsWith(".localhost")) {
        return pass(`${ctx.baseDomain} (loopback domain)`);
      }
      const probeHost = `doctor-probe.${ctx.baseDomain}`;
      const addrs = await ctx.resolveHost(probeHost);
      return addrs.length > 0
        ? pass(`*.${ctx.baseDomain} → ${addrs.join(", ")}`)
        : fail(
            `${probeHost} did not resolve to an IPv4 address.`,
            `Point a wildcard DNS record (*.${ctx.baseDomain}) and deploy.${ctx.baseDomain} at this node's ingress.`,
          );
    },
  },
];
