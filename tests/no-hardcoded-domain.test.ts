import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

// Portability rule: any node must be able to run this code with its own domain,
// so no source file may name a particular one. Tests and docs may.
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

test("no source file hardcodes a deployment domain", () => {
  const offenders = sourceFiles(path.resolve("src")).filter((file) =>
    /tnhc\.dev/i.test(fs.readFileSync(file, "utf8")),
  );
  assert.deepEqual(offenders, []);
});
