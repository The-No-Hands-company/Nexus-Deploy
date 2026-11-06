import assert from "node:assert/strict";
import { test } from "node:test";
import { type NameDeps, SLUG_RE, checkSlug, slugify } from "../src/lib/names.js";

const free: NameDeps = { takenLocally: () => false, takenElsewhere: async () => false };

test("slugify makes a hostname-shaped name out of free text", () => {
  assert.equal(slugify("My App!"), "my-app");
  assert.equal(slugify("  --Hello__World--  "), "hello-world");
  assert.equal(slugify("a".repeat(60)).length, 40);
  assert.equal(slugify("x".repeat(39) + "-y"), "x".repeat(39));
});

test("well-formed slugs pass the format rule and malformed ones do not", () => {
  for (const ok of ["abc", "my-app", "a1b", "web-2-api"]) assert.ok(SLUG_RE.test(ok), ok);
  for (const bad of [
    "",
    "ab",
    "1abc",
    "-abc",
    "abc-",
    "a--b",
    "Abc",
    "a_b",
    "a.b",
    "xn--abc",
    "a".repeat(41),
  ]) {
    assert.ok(!SLUG_RE.test(bad), bad);
  }
});

test("a free, well-formed, unreserved name is accepted", async () => {
  assert.deepEqual(await checkSlug("my-app", free), { ok: true });
});

test("reserved names are refused, so an app can never shadow an ecosystem host", async () => {
  for (const name of ["app", "auth", "deploy", "hosting", "api", "assets"]) {
    const result = await checkSlug(name, free);
    assert.equal(result.ok, false, name);
    assert.equal((result as { reason: string }).reason, "reserved", name);
  }
});

test("a name used by another Deploy project is taken", async () => {
  const result = await checkSlug("my-app", { ...free, takenLocally: (s) => s === "my-app" });
  assert.deepEqual(result.ok, false);
  assert.equal((result as { reason: string }).reason, "taken");
});

test("a name used elsewhere (Cloud's registry or a Hosting site) is taken", async () => {
  const result = await checkSlug("my-app", { ...free, takenElsewhere: async () => true });
  assert.equal((result as { reason: string }).reason, "taken");
});

test("if the registry cannot be asked, the name is refused rather than given out", async () => {
  const result = await checkSlug("my-app", {
    ...free,
    takenElsewhere: async () => {
      throw new Error("hosting unreachable");
    },
  });
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "unverified");
});

test("the outside registries are not consulted for a name that is already refused", async () => {
  let asked = 0;
  const deps: NameDeps = {
    takenLocally: () => false,
    takenElsewhere: async () => {
      asked++;
      return false;
    },
  };
  await checkSlug("Bad Name", deps);
  await checkSlug("deploy", deps);
  assert.equal(asked, 0);
});
