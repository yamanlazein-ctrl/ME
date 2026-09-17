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
