import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { type EdgeSettings, createEdge, liveRoutes } from "../src/lib/edge.js";
import { NullPublisher } from "../src/lib/publisher.js";
import type { Project } from "../src/types.js";

const base: EdgeSettings = {
  cloudUrl: "",
  cloudUserAppsKey: "",
  cloudTimeoutMs: 400,
  cloudHeartbeatMs: 30,
  hostingSiteUrl: "",
  baseDomain: "example.test",
  appHostPattern: "{slug}.{BASE_DOMAIN}",
};

const project = (name: string, status: Project["status"], hostPort?: number): Project =>
  ({ id: `id-${name}`, name, status, ...(hostPort !== undefined ? { hostPort } : {}) }) as Project;

async function fakeCloud(): Promise<{
  url: string;
  calls: string[];
  close: () => Promise<void>;
}> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    if (req.method === "DELETE") return void res.writeHead(204).end();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ taken: false }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

test("only a project that is serving, on a known port, becomes a route", () => {
  const routes = liveRoutes(
    [
      project("serving", "live", 20001),
      project("stopped", "stopped", 20002),
      project("failed", "failed"),
      project("live-without-port", "live"),
    ],
    base,
  );
  assert.deepEqual(routes, [
    { projectId: "id-serving", slug: "serving", host: "serving.example.test", hostPort: 20001 },
  ]);
});

test("the host follows the node's pattern", () => {
  const routes = liveRoutes([project("a", "live", 20001)], {
    ...base,
    appHostPattern: "{slug}.apps.{BASE_DOMAIN}",
  });
  assert.equal(routes[0]?.host, "a.apps.example.test");
});

test("a node with no Cloud announces nothing and finds every name free", async () => {
  const edge = createEdge(base, () => []);
  assert.ok(edge.publisher instanceof NullPublisher);
  assert.equal(await edge.takenElsewhere("my-app"), false);
  await edge.start();
  edge.stop();
});

test("a node with Cloud but no credential refuses to be built", () => {
  assert.throws(
    () => createEdge({ ...base, cloudUrl: "http://127.0.0.1:1", cloudUserAppsKey: "" }, () => []),
    /CLOUD_USER_APPS_KEY/,
  );
});

test("starting announces the apps that were live, keeps announcing them, and removes one that stopped", async () => {
  const cloud = await fakeCloud();
  let projects: Project[] = [
    project("serving", "live", 20001),
    project("stopped", "stopped", 20002),
  ];
  const edge = createEdge({ ...base, cloudUrl: cloud.url, cloudUserAppsKey: "k" }, () => projects);
  try {
    await edge.start();
    assert.deepEqual(cloud.calls, ["PUT /api/v1/user-apps/serving"]);

    await new Promise((r) => setTimeout(r, 120));
    const puts = cloud.calls.filter((c) => c === "PUT /api/v1/user-apps/serving").length;
    assert.ok(puts >= 3, `expected repeated announcements, saw ${puts}`);

    projects = [project("serving", "stopped", 20001)];
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(cloud.calls.includes("DELETE /api/v1/user-apps/serving"));
    const after = cloud.calls.length;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(cloud.calls.length, after, "a stopped app is no longer announced");
  } finally {
    edge.stop();
    await cloud.close();
  }
});

test("starting with Cloud down does not throw, and the node still comes up", async () => {
  const edge = createEdge(
    { ...base, cloudUrl: "http://127.0.0.1:1", cloudUserAppsKey: "k" },
    () => [project("serving", "live", 20001)],
  );
  try {
    await edge.start();
  } finally {
    edge.stop();
  }
});

test("a name check goes to Cloud, and a Cloud that cannot answer fails it", async () => {
  const cloud = await fakeCloud();
  try {
    const up = createEdge({ ...base, cloudUrl: cloud.url, cloudUserAppsKey: "k" }, () => []);
    assert.equal(await up.takenElsewhere("my-app"), false);
    assert.ok(cloud.calls.includes("GET /api/v1/user-apps/my-app/availability"));
  } finally {
    await cloud.close();
  }
  const down = createEdge(
    { ...base, cloudUrl: "http://127.0.0.1:1", cloudUserAppsKey: "k" },
    () => [],
  );
  await assert.rejects(down.takenElsewhere("my-app"));
});
