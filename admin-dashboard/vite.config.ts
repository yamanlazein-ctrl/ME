import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "url";

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
        target: "http://localhost:8081",
        changeOrigin: true,
      },
      "/v1": {
        target: "http://localhost:8081",
        changeOrigin: true,
      },
    },
  },
});
