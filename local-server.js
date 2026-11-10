// Optional local static preview only. API deployment should use `npx vercel dev`.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "public");
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const target = path.join(root, pathname === "/" ? "index.html" : pathname.replace(/^\/+/, ""));
  if (!target.startsWith(root)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(target, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": types[path.extname(target)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(3000, () => console.log("Static preview: http://localhost:3000 (API requires Vercel dev)"));
