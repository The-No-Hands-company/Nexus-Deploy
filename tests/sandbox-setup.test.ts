import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const SCRIPT = "sandbox/setup.sh";

function run(args: string[]) {
  return spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8" });
}

/** The files `--print` would install, by name. */
function printed(extra: string[] = []): Record<string, string> {
  const res = run(["--print", "--deploy-user", "alice", ...extra]);
  assert.equal(res.status, 0, res.stderr);
  const files: Record<string, string> = {};
  let name = "";
  for (const line of res.stdout.split("\n")) {
    const header = /^### (.+)$/.exec(line);
    if (header?.[1]) {
      name = header[1];
      files[name] = "";
    } else if (name) {
      files[name] += `${line}\n`;
    }
  }
  return files;
}

test("the script is valid bash", () => {
  const res = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
});

test("--print writes nothing and prints every file the setup installs", () => {
  const files = printed();
  assert.deepEqual(Object.keys(files), [
    "daemon.json",
    "nexus-sandbox-docker.service",
    "tmpfiles",
    "egress.nft",
    "egress.service",
    "fstab",
    "env",
  ]);
});

test("the daemon caps every container's logs, as the Charter promises", () => {
  const daemon = JSON.parse(printed()["daemon.json"] ?? "") as {
    "log-driver": string;
    "log-opts": Record<string, string>;
  };
  assert.equal(daemon["log-driver"], "local");
  assert.deepEqual(daemon["log-opts"], { "max-size": "10m", "max-file": "2", compress: "false" });
});

test("the daemon is rootless, keeps containers off the host's loopback, and stores on the capped mount", () => {
  const unit = printed()["nexus-sandbox-docker.service"] ?? "";
  assert.match(unit, /dockerd-rootless\.sh/);
  assert.match(unit, /DOCKERD_ROOTLESS_ROOTLESSKIT_DISABLE_HOST_LOOPBACK=true/);
  assert.match(unit, /RequiresMountsFor=\/var\/lib\/nexus-deploy-sandbox\/storage\n/);
  assert.match(unit, /--data-root=\/var\/lib\/nexus-deploy-sandbox\/storage\/docker/);
  assert.match(unit, /--host=unix:\/\/\/run\/nexus-deploy-sandbox\/docker\.sock/);
  assert.match(unit, /Restart=on-failure/);
});

test("only the Deploy account is given the socket", () => {
  const tmpfiles = printed()["tmpfiles"] ?? "";
  assert.match(tmpfiles, /^d \/run\/nexus-deploy-sandbox 0750 nexus-deploy nexus-deploy -$/m);
  const grants = tmpfiles.split("\n").filter((l) => l.startsWith("a+"));
  assert.equal(grants.length, 2);
  for (const line of grants) assert.match(line, /user:alice:/);
  assert.ok(!/other|everyone|::/.test(tmpfiles));
});

test("the egress filter is scoped to the sandbox account and drops private and local ranges", () => {
  const nft = printed()["egress.nft"] ?? "";
  assert.match(nft, /^table inet nexus_deploy_sandbox \{/m);
  assert.match(nft, /hook output/);
  // Every rule is for the sandbox account only, so nothing else on the machine is touched.
  const rules = nft.split("\n").filter((l) => l.trim().startsWith("meta "));
  assert.ok(rules.length >= 2);
  for (const rule of rules) assert.match(rule, /^\s*meta skuid \d+ /);
  for (const range of [
    "127.0.0.0/8",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "169.254.0.0/16",
  ]) {
    assert.ok(nft.includes(range), `drops ${range}`);
  }
  assert.match(nft, /ip6 daddr \{ ::1, fc00::\/7/);
  // Any DNS allowance comes before the drop.
  const lines = rules.map((r) => r.includes(" drop"));
  const firstDrop = lines.indexOf(true);
  assert.ok(firstDrop >= 0);
  assert.ok(
    !lines
      .slice(firstDrop)
      .some((isDrop, i) => !isDrop && rules[firstDrop + i]?.includes("accept")),
  );
});

test("the storage image is mounted nodev,nosuid at the configured place and the node is told where", () => {
  const files = printed(["--image", "/data/sbx.img", "--mount", "/mnt/sbx", "--size-gb", "20"]);
  assert.equal(files["fstab"], "/data/sbx.img /mnt/sbx ext4 loop,nodev,nosuid,noatime 0 0\n");
  assert.match(
    files["env"] ?? "",
    /^SANDBOX_DOCKER_HOST=unix:\/\/\/run\/nexus-deploy-sandbox\/docker\.sock$/m,
  );
  assert.match(files["env"] ?? "", /^SANDBOX_STORAGE_PATH=\/mnt\/sbx$/m);
  assert.match(files["env"] ?? "", /^SANDBOX_STORAGE_SIZE_GB=20$/m);
  assert.match(files["nexus-sandbox-docker.service"] ?? "", /--data-root=\/mnt\/sbx\/docker/);
});

test("bad or missing arguments are refused before anything is done", () => {
  for (const [args, message] of [
    [["--print"], /--deploy-user is required/],
    [["--print", "--deploy-user", "alice", "--size-gb", "2"], /at least 4/],
    [["--print", "--deploy-user", "alice", "--size-gb", "lots"], /whole number/],
    [["--print", "--deploy-user", "nexus-deploy"], /must differ/],
    [["--print", "--deploy-user", "Al ice"], /not a valid account name/],
    [["--print", "--deploy-user", "alice", "--image", "relative.img"], /absolute/],
    [["--print", "--deploy-user", "alice", "--nope"], /unknown option/],
  ] as const) {
    const res = run([...args]);
    assert.notEqual(res.status, 0, args.join(" "));
    assert.match(res.stderr, message, args.join(" "));
  }
});

test("a real run without root is refused", { skip: process.getuid?.() === 0 }, () => {
  const res = run(["--deploy-user", "alice"]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /run as root/);
});
