import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Vite config for Fabric ERP — independent, no third-party wrapper.
 *
 * Plugins:
 *   - TanStack Start (file-based routing, SSR entry: src/server.ts)
 *   - React (JSX/TSX transform, Fast Refresh)
 *   - Tailwind CSS 4 (utility-first styling)
 *   - TypeScript paths (resolves @/* aliases from tsconfig.json)
 */
// Desktop release: build a static single-page app (served by the local backend on the same origin) instead of an
// SSR server. The app has no server functions, so SSR only added a third process, ~10k files and a fixed port.
const desktop = process.env.VITE_DESKTOP_DEPLOY === "true";

export default defineConfig({
  plugins: [
    tanstackStart({
      server: { entry: "server" },
      ...(desktop
        ? { spa: { enabled: true, prerender: { enabled: true, outputPath: "/_shell.html", crawlLinks: false } } }
        : {}),
    }),
    react(),
    tailwindcss(),
    tsconfigPaths(),
  ],
  // Local web: avoid SSR/client optimizer deadlock (Vite fetchModule 60s timeouts).
  optimizeDeps: {
    holdUntilCrawlEnd: false,
  },
  server: {
    // Bind IPv4 explicitly — Windows often resolves localhost to ::1 only,
    // so http://127.0.0.1:5173 fails while http://localhost:5173 works.
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      // Same-origin /api in dev — avoids CORS preflight failures on custom headers.
      "/api": { target: "http://127.0.0.1:8080", changeOrigin: true },
    },
    warmup: {
      clientFiles: ["./src/routes/__root.tsx", "./src/router.tsx"],
      // Pre-bundle SSR entry so the first page load does not hit fetchModule 60s timeouts.
      ssrFiles: ["./src/routes/__root.tsx", "./src/router.tsx", "./src/server.ts"],
    },
  },
  build: {
    // Desktop release build sets VITE_DESKTOP_DEPLOY=true — maps are stripped
    // from the MSI and must not be required at runtime. Keep maps for local
    // web/dev builds only.
    sourcemap: desktop ? false : true,
  },
});
