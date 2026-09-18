import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "url";

// QA worktree sets VITE_LICENSE_PROXY_TARGET=http://127.0.0.1:18091 via qa-start.
// Default stays on the classic license-server port used by ME-main local runs.
const licenseProxyTarget =
  process.env.VITE_LICENSE_PROXY_TARGET?.replace(/\/+$/, "") || "http://127.0.0.1:8081";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5174,
    // Listen on 0.0.0.0 so both 127.0.0.1 and localhost work on Windows
    // (default can bind [::1] only → 127.0.0.1:5174 connection refused).
    host: true,
    proxy: {
      "/license-admin": {
        target: licenseProxyTarget,
        changeOrigin: true,
      },
      "/v1": {
        target: licenseProxyTarget,
        changeOrigin: true,
      },
    },
  },
});
