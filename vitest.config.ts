import { defineConfig } from "vite";
import path from "path";

const options = {
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["node_modules", "dist", ".output"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
};

// Imported from "vite" (not "vitest/config") so Knip can load the file without
// tripping on the ESM-only vitest/config export. Behaviour is identical.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default defineConfig(options as any);
