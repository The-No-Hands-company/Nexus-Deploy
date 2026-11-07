import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { appUrlFor, dashboardHomeUrl, isEmbedded, shortLinkUrlFor } from "../web/src/api.js";

test("dashboard vendored tokens and stylesheet follow the Void theme contract", () => {
  const tokens = fs.readFileSync(path.resolve("web/src/styles/nexus-tokens.css"), "utf8");
  assert.match(tokens, /--nexus-color-bg-canvas:\s*#030303/);
  assert.match(tokens, /--nexus-color-accent-primary:\s*#CCFF00/i);
  assert.match(tokens, /Figtree/);

  const css = fs.readFileSync(path.resolve("web/src/styles/index.css"), "utf8");
  assert.match(css, /@import\s+"\.\/*nexus-tokens\.css";/);
  assert.match(css, /100dvh/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.doesNotMatch(css, /linear-gradient|radial-gradient|backdrop-filter|hsl\(/i);

  const html = fs.readFileSync(path.resolve("web/index.html"), "utf8");
  assert.match(html, /viewport-fit=cover/);
});

test("dashboard URL helpers use the node's configured domain and detect ?embed=1", () => {
  assert.equal(isEmbedded("?embed=1"), true);
  assert.equal(isEmbedded("?embed=0"), false);
  assert.equal(isEmbedded(""), false);

  const node = {
    baseDomain: "local.test",
    controlHost: "deploy.local.test",
    hostPattern: "{slug}.{BASE_DOMAIN}",
  };
  assert.equal(dashboardHomeUrl(node), "https://app.local.test");
  assert.equal(appUrlFor({ name: "demo-app" }, node), "https://demo-app.local.test");
  assert.equal(shortLinkUrlFor({ name: "demo-app" }, node), "https://deploy.local.test/demo-app");
});
