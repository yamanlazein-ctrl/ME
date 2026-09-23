import express, { type Express } from "express";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Desktop runs ONE local server: the API and the built single-page frontend share a single loopback
 * origin/port. There is no separate frontend server, no proxy, no CORS and no second port to collide with.
 *
 * Enabled only when SERVE_STATIC_DIR is set (the desktop shell sets it). The web deployment is unchanged.
 */

/** CSP for HTML documents (helmet's API CSP is `default-src 'none'`, which would block the app itself). */
export const DOCUMENT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  // ipc: / http://ipc.localhost is Tauri's IPC channel on Windows; without it every desktop command (document
  // folders, hub URL, fingerprint …) is blocked by the CSP and falls back to a slower path with console errors.
  "connect-src 'self' ipc: http://ipc.localhost",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

const isApiPath = (p: string): boolean => p === "/api" || p.startsWith("/api/");

export function mountStaticApp(app: Express, dir: string): void {
  const root = resolve(dir);
  const shell = ["_shell.html", "index.html"].map((f) => join(root, f)).find((f) => existsSync(f));
  if (!shell) {
    throw new Error(`SERVE_STATIC_DIR=${root} contains no _shell.html / index.html`);
  }

  // Hashed build assets never change; everything else is revalidated so an update is picked up at once.
  app.use(
    express.static(root, {
      index: false,
      fallthrough: true,
      setHeaders(res, filePath) {
        const p = filePath.split("\\").join("/");
        res.setHeader(
          "Cache-Control",
          p.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
        );
      },
    }),
  );

  // Client-side routes (/customers/123 …) all resolve to the SPA shell.
  app.use((req, res, next) => {
    if ((req.method !== "GET" && req.method !== "HEAD") || isApiPath(req.path)) return next();
    if (!req.accepts("html")) return next();
    res.setHeader("Content-Security-Policy", DOCUMENT_CSP);
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(shell);
  });
}
