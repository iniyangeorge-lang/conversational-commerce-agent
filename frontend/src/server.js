import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("./", import.meta.url);
const files = {
  "/": "demo.html", "/demo.html": "demo.html", "/widget.js": "widget.js",
  "/merchant": "merchant.html", "/merchant/": "merchant.html", "/merchant.html": "merchant.html",
  "/merchant.js": "merchant.js",
};
const port = Number(process.env.FRONTEND_PORT ?? 4173);

http.createServer(async (req, res) => {
  const file = files[req.url];
  if (!file || req.method !== "GET") { res.writeHead(404); return res.end("Not found"); }
  try {
    const body = await readFile(fileURLToPath(new URL(file, root)));
    res.writeHead(200, { "content-type": file.endsWith(".js") ? "application/javascript; charset=utf-8" : "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  } catch { res.writeHead(500); res.end("Unable to load frontend asset"); }
}).listen(port, () => console.log(`[frontend] demo: http://localhost:${port}`));
