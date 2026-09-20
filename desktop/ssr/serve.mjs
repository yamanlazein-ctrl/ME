#!/usr/bin/env node
/**
 * Desktop SSR production launcher (DFP-001).
 *
 * Checked into git under desktop/ssr/ — NOT under the gitignored
 * resources/ tree. `stage-ssr.mjs` / `build-frontend.cmd` copy it to
 * `desktop/src-tauri/resources/ssr/serve.mjs` for packaging.
 *
 * Contract with desktop/src-tauri/src/runtime/stack.rs `spawn_ssr`:
 *   - cwd = resources_root
 *   - env: NODE_ENV=production, SSR_PORT (default 4173), SSR_HOST (127.0.0.1),
 *     SSR_API_PROXY (live backend), RUNTIME_CONFIG_PATH (AppData JSON)
 *   - GET /__health → 200 "ok" (no SSR render — boot readiness probe)
 *   - GET /__runtime-config → JSON { backendPort, apiBaseUrl }
 *   - load Nitro/TanStack handler from ./ssr/dist/server/server.js
 *     (path relative to resources_root when cwd is resources_root)
 *
 * When this file is placed at resources/ssr/serve.mjs, the handler path is
 * ./dist/server/server.js relative to this file.
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { resolveApiProxy, readRuntimeConfig } from "./resolve-api-proxy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.SSR_PORT || 4173);
const HOST = process.env.SSR_HOST || "127.0.0.1";
const API_PROXY = resolveApiProxy(process.env).replace(/\/+$/, "");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

const handlerUrl = pathToFileURL(join(HERE, "dist", "server", "server.js")).href;
const { default: serverEntry } = await import(handlerUrl);
const handler =
  serverEntry && typeof serverEntry.fetch === "function"
    ? serverEntry
    : serverEntry?.default && typeof serverEntry.default.fetch === "function"
      ? serverEntry.default
      : null;
if (!handler) {
  console.error("[ssr] dist/server/server.js does not export a fetch handler");
  process.exit(1);
}

const clientRoot = join(HERE, "dist", "client");

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent((urlPath || "/").split("?")[0]);
  const rel = decoded.replace(/^\/+/, "").replace(/\//g, sep);
  const full = normalize(join(root, rel));
  if (!full.startsWith(normalize(root + sep)) && full !== normalize(root)) return null;
  return full;
}

function tryStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const filePath = safeJoin(clientRoot, url.pathname === "/" ? "/index.html" : url.pathname);
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) return false;
  const type = MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=31536000, immutable" });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  createReadStream(filePath).pipe(res);
  return true;
}

async function proxyApi(req, res) {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  if (!url.pathname.startsWith("/api")) return false;
  try {
    const upstream = await fetch(`${API_PROXY}${url.pathname}${url.search}`, {
      method: req.method,
      headers: req.headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : req,
      duplex: "half",
    });
    res.writeHead(upstream.status, Object.fromEntries(upstream.headers));
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
  } catch (err) {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`api proxy error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return true;
}

function nodeReqToFetchRequest(req) {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else headers.set(k, v);
  }
  const init = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req;
    init.duplex = "half";
  }
  return new Request(url, init);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    if (url.pathname === "/__health") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }
    if (url.pathname === "/__runtime-config") {
      const fromFile = readRuntimeConfig(process.env.RUNTIME_CONFIG_PATH);
      const body = fromFile ?? {
        apiBaseUrl: API_PROXY,
        backendPort: Number(new URL(API_PROXY).port) || 8080,
      };
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
      return;
    }
    if (await proxyApi(req, res)) return;
    if (tryStatic(req, res)) return;

    const request = nodeReqToFetchRequest(req);
    const response = await handler.fetch(request, {}, {});
    const headers = Object.fromEntries(response.headers);
    res.writeHead(response.status, headers);
    const buf = Buffer.from(await response.arrayBuffer());
    res.end(buf);
  } catch (err) {
    console.error("[ssr]", err);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end("ssr error");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[ssr] listening on http://${HOST}:${PORT} (api → ${API_PROXY})`);
});
