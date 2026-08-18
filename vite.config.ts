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
 *
 * Proxy: /api → localhost:8083 (Express backend)
 */
export default defineConfig({
  plugins: [
    tanstackStart({ server: { entry: "server" } }),
    react(),
    tailwindcss(),
    tsconfigPaths(),
  ],
  server: {
    proxy: {
      "/api": { target: "http://localhost:8083", changeOrigin: true },
    },
  },
  build: {
    sourcemap: true,
  },
});
