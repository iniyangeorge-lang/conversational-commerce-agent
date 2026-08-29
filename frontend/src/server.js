// Zero-dependency static server for the demo pages. `npm run dev -w @cca/frontend`
//   /            -> index.html   (storefront + chat widget)
//   /merchant    -> merchant.html (merchant dashboard)
//   plus any .html/.js/.css/.json file in this directory.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("./", import.meta.url));
const TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
};
const port = Number(process.env.FRONTEND_PORT ?? 4173);

http
  .createServer(async (req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405);
      return res.end("Method not allowed");
    }
    let name = decodeURIComponent(req.url.split("?")[0]);
    if (name === "/") name = "/index.html";
    else if (name === "/merchant" || name === "/merchant/") name = "/merchant.html";

    const safe = normalize(name).replace(/^(\.\.[/\\])+/, "");
    const path = join(dir, safe);
    if (!path.startsWith(dir) || !TYPES[extname(path)]) {
      res.writeHead(404);
      return res.end("Not found");
    }
    try {
      const body = await readFile(path);
      res.writeHead(200, {
        "content-type": `${TYPES[extname(path)]}; charset=utf-8`,
        "cache-control": "no-store",
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  })
  .listen(port, () => console.log(`[frontend] http://localhost:${port}`));
