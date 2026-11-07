import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const port = Number(process.env.PORT || 3000);
const version = process.env.RELEASE_VERSION || "v1";
const failHealth = process.env.FAIL_HEALTH === "true";
const volumeDir = process.env.VOLUME_DIR || "/data";
const stateFile = path.join(volumeDir, "state.txt");

const server = http.createServer((req, res) => {
  if (failHealth) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, version, reason: "intentionally unhealthy" }));
    return;
  }
  if (req.url === "/volume" && req.method === "POST") {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      fs.mkdirSync(volumeDir, { recursive: true });
      fs.writeFileSync(stateFile, body, "utf8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, written: body }));
    });
    return;
  }
  if (req.url === "/volume" && req.method === "GET") {
    const value = fs.existsSync(stateFile) ? fs.readFileSync(stateFile, "utf8") : "";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, version, value }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      ok: true,
      fixture: "dockerfile",
      version,
      path: req.url || "/",
      headers: req.headers,
    }),
  );
});

server.listen(port, "0.0.0.0");
