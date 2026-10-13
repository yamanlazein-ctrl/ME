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
    // ERP-005: loopback only. The proxy below reaches the license server from loopback, which
    // opens the passwordless owner console — a LAN-reachable dev server would hand that to any
    // remote caller. 127.0.0.1 (not the default, which can bind [::1] only on Windows).
    // Set ADMIN_DASHBOARD_HOST to expose it deliberately; the backend still refuses the open
    // console for a forwarded non-loopback client (xfwd below).
    host: process.env.ADMIN_DASHBOARD_HOST || "127.0.0.1",
    proxy: {
      "/license-admin": {
        target: licenseProxyTarget,
        changeOrigin: true,
        xfwd: true,
      },
      "/v1": {
        target: licenseProxyTarget,
        changeOrigin: true,
        xfwd: true,
      },
    },
  },
});
