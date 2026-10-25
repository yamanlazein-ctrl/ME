import { defineConfig } from "vitest/config";
import path from "node:path";

const here = __dirname;

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["test/**/*.test.{ts,tsx}"],
    // Inline drizzle so the better-sqlite3 alias below also applies to its own import.
    server: { deps: { inline: [/drizzle-orm/] } },
  },
  resolve: {
    alias: {
      "@backend": path.resolve(here, "../backend/src"),
      "@erp/shared/": path.resolve(here, "../packages/shared/src") + "/",
      "@erp/shared": path.resolve(here, "../packages/shared/src/index.ts"),
      // Node tests run the real driver (tests only; the app bundle maps this name to BetterSqliteShim.ts).
      "better-sqlite3": path.resolve(here, "../backend/node_modules/better-sqlite3"),
      "@op-engineering/op-sqlite": path.resolve(here, "test/helpers/opSqliteStub.ts"),
      "expo-crypto": path.resolve(here, "test/helpers/expoCryptoNode.ts"),
      "@web": path.resolve(here, "../src"),
    },
  },
});
