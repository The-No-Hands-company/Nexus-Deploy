import assert from "node:assert/strict";
import { test } from "node:test";
import { appHost, appUrl, parsePortRange } from "../src/lib/hosts.js";

test("the default pattern puts the slug one level under the base domain", () => {
  assert.equal(appHost("my-app", "{slug}.{BASE_DOMAIN}", "example.test"), "my-app.example.test");
  assert.equal(appUrl("my-app", "{slug}.{BASE_DOMAIN}", "example.test"), "https://my-app.example.test");
});

test("a node can choose a different pattern", () => {
  assert.equal(appHost("a", "{slug}-apps.{BASE_DOMAIN}", "node.test"), "a-apps.node.test");
});

test("a pattern without {slug} is refused, because every app would share one host", () => {
  assert.throws(() => appHost("a", "apps.{BASE_DOMAIN}", "node.test"), /\{slug\}/);
});

test("port ranges parse, and refuse privileged ports, reversed bounds and junk", () => {
  assert.deepEqual(parsePortRange("20000-29999"), { min: 20000, max: 29999 });
  assert.deepEqual(parsePortRange(" 3000-3001 "), { min: 3000, max: 3001 });
  for (const bad of ["", "abc", "1-2000", "30000-20000", "20000-70000", "20000", "20000-"]) {
    assert.throws(() => parsePortRange(bad), /APP_PORT_RANGE/, bad);
  }
});
