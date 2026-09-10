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
export default defineConfig({
  plugins: [
    tanstackStart({ server: { entry: "server" } }),
    react(),
    tailwindcss(),
    tsconfigPaths(),
  ],
  // Local web: avoid SSR/client optimizer deadlock (Vite fetchModule 60s timeouts).
  optimizeDeps: {
    holdUntilCrawlEnd: false,
  },
  server: {
    warmup: {
      clientFiles: ["./src/routes/__root.tsx", "./src/router.tsx"],
    },
  },
  build: {
    // Desktop release build sets VITE_DESKTOP_DEPLOY=true — maps are stripped
    // from the MSI and must not be required at runtime. Keep maps for local
    // web/dev builds only.
    sourcemap: process.env.VITE_DESKTOP_DEPLOY === "true" ? false : true,
  },
});
