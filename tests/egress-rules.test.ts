import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

/**
 * Applies the egress rules the setup script generates inside a throwaway user and
 * network namespace (no root, no effect on this machine) and sends datagrams as
 * the account the rules name. UDP is used so the test needs no listener to reply:
 * a dropped send fails with EPERM at the sender, a delivered one arrives.
 */

const have = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
const namespacesWork =
  have("unshare") &&
  have("nft") &&
  have("ip") &&
  spawnSync("unshare", ["-rn", "true"]).status === 0;
const skip = namespacesWork ? false : "needs unshare, nft and ip with unprivileged namespaces";

function renderedRules(): string {
  const res = spawnSync("bash", ["sandbox/setup.sh", "--print", "--deploy-user", "alice"], {
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  const text = res.stdout.split("### egress.nft\n")[1]?.split("### ")[0] ?? "";
  // Inside the namespace the account is root, uid 0.
  return text.replaceAll(/meta skuid \d+/g, "meta skuid 0");
}

/** Send one UDP datagram to addr:port from inside the namespace; report what happened. */
const PROBE = `
const dgram = require("node:dgram");
const [addr, port] = process.argv.slice(1);
const rx = dgram.createSocket("udp4");
rx.on("error", () => {});
const tx = dgram.createSocket("udp4");
let outcome = "silent";
rx.on("message", () => { outcome = "delivered"; });
rx.bind(Number(port), addr, () => {
  tx.send("x", Number(port), addr, (err) => {
    if (err) outcome = err.code;
    setTimeout(() => { console.log(outcome); process.exit(0); }, 300);
  });
});
rx.on("error", () => { console.log("bind-failed"); process.exit(0); });
`;

function probe(rules: string | null, addrOnLo: string, port: number): string {
  const script = [
    "set -e",
    "ip link set lo up",
    `ip addr add ${addrOnLo}/32 dev lo 2>/dev/null || true`,
    rules ? `nft -f - <<'RULES'\n${rules}\nRULES` : "true",
    `node -e '${PROBE}' ${addrOnLo} ${port}`,
  ].join("\n");
  const res = spawnSync("unshare", ["-rn", "bash", "-c", script], { encoding: "utf8" });
  return res.stdout.trim().split("\n").pop() ?? `no output: ${res.stderr}`;
}

test(
  "without the rules, a datagram to a local address is delivered (the control)",
  { skip },
  () => {
    assert.equal(probe(null, "127.0.0.1", 40001), "delivered");
  },
);

test(
  "with the rules, the sandbox account cannot send to loopback or private networks",
  { skip },
  () => {
    const rules = renderedRules();
    for (const [addr, port] of [
      ["127.0.0.1", 40002],
      ["10.1.2.3", 40003],
      ["172.20.0.1", 40004],
      ["192.168.77.5", 40005],
    ] as const) {
      assert.equal(probe(rules, addr, port), "EPERM", `${addr} must be blocked`);
    }
  },
);

test("with the rules, a public address is not blocked by them", { skip }, () => {
  // Nothing is listening and there is no route in an empty namespace, so the
  // datagram goes nowhere; what matters is that the filter did not stop it.
  const outcome = probe(renderedRules(), "93.184.216.34", 40006);
  assert.notEqual(outcome, "EPERM");
});

test("with the rules, DNS to a resolver the machine uses is allowed", { skip }, () => {
  const rules = renderedRules();
  const match = /ip daddr (\d+\.\d+\.\d+\.\d+) udp dport 53 accept/.exec(rules);
  if (!match?.[1]) return; // this machine names no IPv4 resolver; nothing to allow
  assert.equal(probe(rules, match[1], 53), "delivered");
});
