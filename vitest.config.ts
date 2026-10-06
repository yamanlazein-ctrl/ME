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
      // Specific sub-paths MUST precede the bare "@erp/shared" entry: Vite
      // matches string aliases as exact-or-prefix, so a bare key listed first
      // would swallow "@erp/shared/statementPaging" and rewrite it under
      // index.ts.
      "@erp/shared/statementPaging": path.resolve(__dirname, "./packages/shared/src/statementPaging.ts"),
      "@erp/shared/precision": path.resolve(__dirname, "./packages/shared/src/precision.ts"),
      "@erp/shared/schemas/invoice.schema": path.resolve(__dirname, "./packages/shared/src/schemas/invoice.schema.ts"),
      "@erp/shared": path.resolve(__dirname, "./packages/shared/src/index.ts"),
    },
  },
};

// Imported from "vite" (not "vitest/config") so Knip can load the file without
// tripping on the ESM-only vitest/config export. Behaviour is identical.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default defineConfig(options as any);
