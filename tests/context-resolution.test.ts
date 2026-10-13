import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as build from "../src/lib/build.js";

// These catch accidental use of the clone root and symlinks escaping it.
test("resolves the default and a nested context inside the clone", () => {
  const resolve = (build as unknown as { resolveBuildContext?: (root: string, value?: unknown) => string }).resolveBuildContext;
  assert.equal(typeof resolve, "function", "build context resolver is missing");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-context-"));
  try {
    fs.mkdirSync(path.join(root, "apps/calendar"), { recursive: true });
    assert.equal(resolve!(root), fs.realpathSync(root));
    assert.equal(resolve!(root, "apps/calendar"), path.join(fs.realpathSync(root), "apps/calendar"));
    fs.writeFileSync(path.join(root, "file"), "not a directory");
    for (const value of ["missing", "file", "../outside", "/tmp"]) assert.throws(() => resolve!(root, value));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("rejects context symlinks outside the clone including prefix siblings", () => {
  const resolve = (build as unknown as { resolveBuildContext?: (root: string, value?: unknown) => string }).resolveBuildContext;
  assert.equal(typeof resolve, "function", "build context resolver is missing");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-context-"));
  const outside = `${root}-outside`;
  try {
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(root, "escape"));
    assert.throws(() => resolve!(root, "escape"), /buildContext/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
