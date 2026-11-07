// Local test server: serves /public and runs the API with in-memory storage.
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
globalThis.__EW_MEM__ = new Map(); process.env.ADMIN_PIN ||= "1234";
const { default: api } = await import("../netlify/functions/api.mjs");
const root = path.resolve("public"); const types = {".html":"text/html",".png":"image/png",".js":"text/javascript",".css":"text/css"};
http.createServer(async (req, res) => {
  if (req.url.startsWith("/api/")) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = new Request("http://localhost" + req.url, { method: req.method, headers: req.headers, body: ["GET","HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
    const out = await api(r); res.writeHead(out.status, Object.fromEntries(out.headers)); res.end(Buffer.from(await out.arrayBuffer())); return;
  }
  const f = path.join(root, req.url === "/" ? "index.html" : decodeURIComponent(req.url.split("?")[0]));
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": types[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
}).listen(8899, () => console.log("ready"));
