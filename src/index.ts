import { createServer } from "node:http";
import { createApp } from "./app.js";
import { setRoutePublisher } from "./lib/build.js";
import { config, ensureDataDir } from "./lib/config.js";
import { startStatusSync } from "./lib/status-sync.js";
import { realDeps, realEdge } from "./lib/wiring.js";
import { attachSockets } from "./lib/ws.js";

ensureDataDir();
const edge = realEdge();
// The release pipeline announces new releases through this.
setRoutePublisher(edge.publisher);
const deps = realDeps(edge);
const server = createServer(createApp(deps));
attachSockets(server, deps);

startStatusSync(30_000);

server.listen(config.port, () => {
  void edge.start();
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
