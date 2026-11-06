import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
  CloudError,
  CloudPublisher,
  type CloudSettings,
  cloudNameTaken,
  hostingNameTaken,
  makeTakenElsewhere,
} from "../src/lib/cloud.js";

type Seen = { method: string; url: string; auth: string | undefined; body: string; host: string };

/** A stand-in server: records requests, answers with whatever `reply` says. */
async function serve(
  reply: (seen: Seen) => { status: number; body?: string } | "hang",
): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const entry: Seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        auth: req.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
        host: req.headers.host ?? "",
      };
      seen.push(entry);
      const answer = reply(entry);
      if (answer === "hang") return;
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(answer.body ?? "");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const settings = (url: string): CloudSettings => ({ url, key: "k-test", timeoutMs: 400 });
const route = (slug: string, hostPort: number) => ({
  projectId: `p-${slug}`,
  slug,
  host: `${slug}.example.test`,
  hostPort,
});

test("publishing PUTs the loopback port with the user-apps credential", async () => {
  const cloud = await serve(() => ({ status: 200, body: "{}" }));
  try {
    await new CloudPublisher(settings(cloud.url)).publish(route("my-app", 20007));
    assert.equal(cloud.seen.length, 1);
    assert.equal(cloud.seen[0]?.method, "PUT");
    assert.equal(cloud.seen[0]?.url, "/api/v1/user-apps/my-app");
    assert.equal(cloud.seen[0]?.auth, "Bearer k-test");
    assert.deepEqual(JSON.parse(cloud.seen[0]?.body ?? ""), {
      upstreamUrl: "http://127.0.0.1:20007",
    });
  } finally {
    await cloud.close();
  }
});

test("a name Cloud says is taken, any refusal, a dead Cloud and a slow Cloud all fail the publish", async () => {
  for (const [status, pattern] of [
    [409, /already in use/],
    [403, /HTTP 403/],
    [401, /HTTP 401/],
    [503, /HTTP 503/],
  ] as const) {
    const cloud = await serve(() => ({ status }));
    try {
      await assert.rejects(
        new CloudPublisher(settings(cloud.url)).publish(route("a-b", 20001)),
        (e) => {
          assert.ok(e instanceof CloudError);
          assert.match(e.message, pattern);
          assert.equal(e.status, status);
          return true;
        },
      );
    } finally {
      await cloud.close();
    }
  }
  await assert.rejects(
    new CloudPublisher(settings("http://127.0.0.1:1")).publish(route("a-b", 20001)),
    /could not be reached/,
  );
  const slow = await serve(() => "hang");
  try {
    await assert.rejects(
      new CloudPublisher(settings(slow.url)).publish(route("a-b", 20001)),
      /could not be reached/,
    );
  } finally {
    await slow.close();
  }
});

test("a publisher cannot be built without a URL or a key", () => {
  assert.throws(() => new CloudPublisher({ url: "", key: "k", timeoutMs: 1 }), /CLOUD_URL/);
  assert.throws(
    () => new CloudPublisher({ url: "http://x", key: "", timeoutMs: 1 }),
    /CLOUD_USER_APPS_KEY/,
  );
});

test("unpublishing DELETEs, and an already-gone route is fine", async () => {
  for (const status of [204, 404]) {
    const cloud = await serve(() => ({ status }));
    try {
      await new CloudPublisher(settings(cloud.url)).unpublish("my-app");
      assert.equal(cloud.seen[0]?.method, "DELETE");
      assert.equal(cloud.seen[0]?.url, "/api/v1/user-apps/my-app");
    } finally {
      await cloud.close();
    }
  }
  const broken = await serve(() => ({ status: 500 }));
  try {
    await assert.rejects(new CloudPublisher(settings(broken.url)).unpublish("my-app"), /HTTP 500/);
  } finally {
    await broken.close();
  }
});

test("refresh re-announces live routes and removes the ones that stopped", async () => {
  const cloud = await serve((s) => ({ status: s.method === "DELETE" ? 204 : 200 }));
  try {
    const publisher = new CloudPublisher(settings(cloud.url));
    await publisher.publish(route("alive", 20001));
    await publisher.publish(route("stopped", 20002));
    cloud.seen.length = 0;

    const failed = await publisher.refresh((slug) => slug === "alive");
    assert.equal(failed, 0);
    assert.deepEqual(cloud.seen.map((s) => `${s.method} ${s.url}`).sort(), [
      "DELETE /api/v1/user-apps/stopped",
      "PUT /api/v1/user-apps/alive",
    ]);

    // The stopped route is forgotten, so it is not touched again.
    cloud.seen.length = 0;
    await publisher.refresh(() => true);
    assert.deepEqual(
      cloud.seen.map((s) => s.url),
      ["/api/v1/user-apps/alive"],
    );
  } finally {
    await cloud.close();
  }
});

test("refresh counts failures instead of throwing, so one bad route does not stop the rest", async () => {
  let n = 0;
  const cloud = await serve(() => ({ status: n++ === 2 ? 500 : 200 }));
  try {
    const publisher = new CloudPublisher(settings(cloud.url));
    await publisher.publish(route("one", 20001));
    await publisher.publish(route("two", 20002));
    const failed = await publisher.refresh(() => true);
    assert.equal(failed, 1);
    assert.equal(cloud.seen.length, 4, "the second route was still announced");
  } finally {
    await cloud.close();
  }
});

test("restore announces earlier routes and reports how many failed", async () => {
  const cloud = await serve((s) => ({ status: s.url.endsWith("/bad") ? 409 : 200 }));
  try {
    const publisher = new CloudPublisher(settings(cloud.url));
    const failed = await publisher.restore([route("good", 20001), route("bad", 20002)]);
    assert.equal(failed, 1);
    assert.equal(cloud.seen.length, 2);
  } finally {
    await cloud.close();
  }
});

test("Cloud's availability answer is passed on, and anything unreadable is an error", async () => {
  for (const taken of [true, false]) {
    const cloud = await serve(() => ({ status: 200, body: JSON.stringify({ taken }) }));
    try {
      assert.equal(await cloudNameTaken(settings(cloud.url), "my-app"), taken);
      assert.equal(cloud.seen[0]?.url, "/api/v1/user-apps/my-app/availability");
    } finally {
      await cloud.close();
    }
  }
  for (const reply of [
    { status: 200, body: "not json" },
    { status: 200, body: JSON.stringify({ taken: "no" }) },
    { status: 500 },
  ]) {
    const cloud = await serve(() => reply);
    try {
      await assert.rejects(cloudNameTaken(settings(cloud.url), "my-app"), CloudError);
    } finally {
      await cloud.close();
    }
  }
});

const NO_SITE = "<h1>404</h1><p>No site found for <code>x</code></p>";

test("Hosting: its own 'No site found' 404 means the name is free; any site means taken", async () => {
  const free = await serve(() => ({ status: 404, body: NO_SITE }));
  const site = await serve(() => ({ status: 200, body: "<p>a site</p>" }));
  const privateSite = await serve(() => ({ status: 403, body: "private" }));
  const siteWithOwn404 = await serve(() => ({
    status: 404,
    body: "<p>this site has no page here</p>",
  }));
  try {
    assert.equal(await hostingNameTaken(free.url, "my-app.example.test", 400), false);
    assert.equal(await hostingNameTaken(site.url, "my-app.example.test", 400), true);
    assert.equal(await hostingNameTaken(privateSite.url, "my-app.example.test", 400), true);
    assert.equal(await hostingNameTaken(siteWithOwn404.url, "my-app.example.test", 400), true);
    assert.equal(free.seen[0]?.host, "my-app.example.test", "asks by the app's host");
  } finally {
    await Promise.all([free.close(), site.close(), privateSite.close(), siteWithOwn404.close()]);
  }
});

test("Hosting: a 5xx, a refused connection and a hang are 'could not check', not 'free'", async () => {
  const broken = await serve(() => ({ status: 502, body: "bad gateway" }));
  const slow = await serve(() => "hang");
  try {
    await assert.rejects(hostingNameTaken(broken.url, "a.example.test", 400), CloudError);
    await assert.rejects(hostingNameTaken("http://127.0.0.1:1", "a.example.test", 400));
    await assert.rejects(hostingNameTaken(slow.url, "a.example.test", 150), /in time/);
  } finally {
    await Promise.all([broken.close(), slow.close()]);
  }
});

test("the combined check is taken if any neighbour says so, and fails if any cannot be asked", async () => {
  const cloud = await serve(() => ({ status: 200, body: JSON.stringify({ taken: false }) }));
  const hosting = await serve(() => ({ status: 404, body: NO_SITE }));
  const takenHosting = await serve(() => ({ status: 200, body: "site" }));
  const hostOf = (slug: string) => `${slug}.example.test`;
  try {
    const free = makeTakenElsewhere({
      cloud: settings(cloud.url),
      hostingSiteUrl: hosting.url,
      hostOf,
      timeoutMs: 400,
    });
    assert.equal(await free("my-app"), false);

    const hostingTaken = makeTakenElsewhere({
      cloud: settings(cloud.url),
      hostingSiteUrl: takenHosting.url,
      hostOf,
      timeoutMs: 400,
    });
    assert.equal(await hostingTaken("my-app"), true);

    const deadHosting = makeTakenElsewhere({
      cloud: settings(cloud.url),
      hostingSiteUrl: "http://127.0.0.1:1",
      hostOf,
      timeoutMs: 400,
    });
    await assert.rejects(deadHosting("my-app"));

    const deadCloud = makeTakenElsewhere({
      cloud: settings("http://127.0.0.1:1"),
      hostOf,
      timeoutMs: 400,
    });
    await assert.rejects(deadCloud("my-app"));

    // Nothing configured: there is no neighbour to ask.
    assert.equal(await makeTakenElsewhere({ hostOf, timeoutMs: 400 })("my-app"), false);
  } finally {
    await Promise.all([cloud.close(), hosting.close(), takenHosting.close()]);
  }
});
