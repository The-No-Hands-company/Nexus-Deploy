import http from "node:http";

const port = Number(process.env.PORT || 3000);

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      ok: true,
      fixture: "node",
      path: req.url || "/",
      headers: req.headers,
    }),
  );
});

server.listen(port, "0.0.0.0");
