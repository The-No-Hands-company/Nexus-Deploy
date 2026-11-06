import assert from "node:assert/strict";
import { test } from "node:test";
import { imagesToPrune, keepRefs } from "../src/lib/prune.js";

const img = (repository: string, tag: string, digest = "<none>", id = "id0000000000") => ({
  repository,
  tag,
  digest,
  id,
});

test("the running image, the rollback image and the few most recent deployments are kept", () => {
  const keep = keepRefs({
    projects: [{ id: "p", imageTag: "nexus/a:cur", previousImageTag: "nexus/a:prev" }],
    deployments: [
      { projectId: "p", imageTag: "nexus/a:d1", createdAt: 1 },
      { projectId: "p", imageTag: "nexus/a:d2", createdAt: 2 },
      { projectId: "p", imageTag: "nexus/a:d3", createdAt: 3 },
      { projectId: "p", imageTag: "nexus/a:d4", createdAt: 4 },
      { projectId: "p", imageTag: "", createdAt: 5 },
    ],
  });
  assert.deepEqual([...keep].sort(), [
    "nexus/a:cur",
    "nexus/a:d2",
    "nexus/a:d3",
    "nexus/a:d4",
    "nexus/a:prev",
  ]);
});

test("another project's deployments do not keep this one's images alive, nor the reverse", () => {
  const keep = keepRefs(
    {
      projects: [{ id: "a" }, { id: "b" }],
      deployments: [
        { projectId: "a", imageTag: "nexus/a:1", createdAt: 1 },
        { projectId: "b", imageTag: "nexus/b:1", createdAt: 2 },
      ],
    },
    1,
  );
  assert.deepEqual([...keep].sort(), ["nexus/a:1", "nexus/b:1"]);
});

test("unreferenced images are pruned and referenced ones are not", () => {
  const listed = [img("nexus/a", "cur"), img("nexus/a", "old"), img("nginx", "1.27")];
  assert.deepEqual(imagesToPrune(listed, new Set(["nexus/a:cur"])), ["nexus/a:old", "nginx:1.27"]);
});

test("a pulled image recorded by digest is kept even though it is listed by tag", () => {
  const digest = `sha256:${"d".repeat(64)}`;
  const listed = [img("nginx", "1.27", digest), img("nginx", "1.26", `sha256:${"e".repeat(64)}`)];
  assert.deepEqual(imagesToPrune(listed, new Set([`nginx@${digest}`])), ["nginx:1.26"]);
});

test("untagged images are pruned by id", () => {
  assert.deepEqual(imagesToPrune([img("<none>", "<none>", "<none>", "abc123def456")], new Set()), [
    "abc123def456",
  ]);
});

test("an empty node prunes nothing", () => {
  assert.deepEqual(imagesToPrune([], new Set()), []);
});
