import { createServer } from "node:http";
import { createApp } from "./app.js";
import { config, ensureDataDir } from "./lib/config.js";
import { startStatusSync } from "./lib/status-sync.js";
import { realDeps } from "./lib/wiring.js";

ensureDataDir();
const deps = realDeps();
const server = createServer(createApp(deps));

startStatusSync(30_000);

server.listen(config.port, () => {
  console.log(`
╔════════════════════════════════════════╗
║        NEXUS DEPLOY  v${deps.version.padEnd(16)}║
║   The No Hands Company · Free forever ║
╠════════════════════════════════════════╣
║  ${config.baseUrl.padEnd(38)}║
║  *.${config.baseDomain.padEnd(36)}║
╚════════════════════════════════════════╝
  `);
});
