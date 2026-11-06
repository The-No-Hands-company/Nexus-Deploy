import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { allocatePort, loopbackPortFree, portsInUse } from "../src/lib/ports.js";

const yes = async () => true;

test("a free port in the range is chosen, starting where asked", async () => {
  assert.equal(await allocatePort({ min: 20000, max: 20009 }, new Set(), yes, 3), 20003);
});

test("ports already in use are skipped, wrapping around the end of the range", async () => {
  const used = new Set([20008, 20009, 20000]);
  assert.equal(await allocatePort({ min: 20000, max: 20009 }, used, yes, 8), 20001);
});

test("ports the operating system says are taken are skipped too", async () => {
  const busy = new Set([20000, 20001]);
  assert.equal(await allocatePort({ min: 20000, max: 20003 }, new Set(), async (p) => !busy.has(p), 0), 20002);
});

test("when the whole range is taken there is no port", async () => {
  assert.equal(await allocatePort({ min: 20000, max: 20002 }, new Set([20000, 20001, 20002]), yes, 0), null);
  assert.equal(await allocatePort({ min: 20000, max: 20002 }, new Set(), async () => false, 0), null);
});

test("a single-port range works", async () => {
  assert.equal(await allocatePort({ min: 31000, max: 31000 }, new Set(), yes), 31000);
});

test("ports held by projects, current or reserved, are all counted", () => {
  const used = portsInUse([{ hostPort: 20001 }, { pendingPort: 20002 }, { hostPort: 20003, pendingPort: 20004 }, {}]);
  assert.deepEqual([...used].sort(), [20001, 20002, 20003, 20004]);
});

test("the real check sees a port that something is listening on", async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  assert.equal(await loopbackPortFree(port), false);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal(await loopbackPortFree(port), true);
});
