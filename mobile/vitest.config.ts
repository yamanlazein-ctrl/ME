import { defineConfig, type Plugin } from "vitest/config";
import { createRequire } from "node:module";
import path from "node:path";

const here = __dirname;
const requireCjs = createRequire(__filename);
const { ADAPTERS, FILE_ADAPTERS, IMPORTER_ADAPTERS, backendSrc } = requireCjs(
  "./adapters.config.js",
) as {
  ADAPTERS: Record<string, string>;
  FILE_ADAPTERS: Record<string, string>;
  IMPORTER_ADAPTERS: Array<[string, string, string]>;
  backendSrc: string;
};
const sharedSrc = path.resolve(here, "../packages/shared/src");
const mobileSrc = path.resolve(here, "src");

// Node tests of phone code run against the SAME adapters the app bundle uses (adapters.config.js), except for the SQLite
// driver, which stays the real better-sqlite3 (tests only).
const NODE_TEST_ADAPTERS = ["node:crypto", "node:async_hooks"];

function phoneAdapters(): Plugin {
  const inPhoneCode = (file: string) =>
    file.startsWith(backendSrc) || file.startsWith(sharedSrc) || file.startsWith(mobileSrc);
  // Vite never offers `node:*` built-ins to resolveId, so the specifiers are rewritten in the source text instead.
  const rewrite = (code: string, name: string, adapter: string) =>
    code.split(`"${name}"`).join(`"${adapter}"`).split(`'${name}'`).join(`'${adapter}'`);
  return {
    name: "phone-adapters",
    enforce: "pre",
    transform(code, id) {
      const file = id.split("?")[0] as string;
      if (!inPhoneCode(file)) return null;
      let out = code;
      for (const [importer, name, adapter] of IMPORTER_ADAPTERS) {
        if (file === importer) out = rewrite(out, name, adapter);
      }
      for (const name of NODE_TEST_ADAPTERS) {
        const adapter = ADAPTERS[name];
        if (adapter && file !== adapter) out = rewrite(out, name, adapter);
      }
      return out === code ? null : { code: out, map: null };
    },
    resolveId(source, importer) {
      if (!importer) return null;
      const from = importer.split("?")[0] as string;
      if (!inPhoneCode(from)) return null;
      let target: string | null = null;
      if (source.startsWith("@backend/"))
        target = path.join(backendSrc, source.slice("@backend/".length));
      else if (source.startsWith(".")) target = path.resolve(path.dirname(from), source);
      if (target) {
        const adapter = FILE_ADAPTERS[`${target.replace(/\.(js|ts)$/, "")}.ts`];
        if (adapter) return adapter;
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [phoneAdapters()],
  // The Expo tsconfig keeps JSX for Metro; Node tests need it compiled.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    globals: true,
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Inline drizzle so the better-sqlite3 alias below also applies to its own import.
    server: {
      deps: { inline: [/drizzle-orm/, /@testing-library\/react-native/, /test-renderer/] },
    },
  },
  resolve: {
    alias: {
      "@backend": path.resolve(here, "../backend/src"),
      "@erp/shared/": path.resolve(here, "../packages/shared/src") + "/",
      "@erp/shared": path.resolve(here, "../packages/shared/src/index.ts"),
      // Node tests run the real driver (tests only; the app bundle maps this name to BetterSqliteShim.ts).
      "better-sqlite3": path.resolve(here, "../backend/node_modules/better-sqlite3"),
      "@op-engineering/op-sqlite": path.resolve(here, "test/helpers/opSqliteStub.ts"),
      "react-native": path.resolve(here, "test/helpers/reactNativeStub.cjs"),
      "react-native-argon2": path.resolve(here, "test/helpers/argon2Stub.ts"),
      "expo-constants": path.resolve(here, "test/helpers/expoConstantsStub.ts"),
      "expo-secure-store": path.resolve(here, "test/helpers/expoSecureStoreMemory.ts"),
      "expo-crypto": path.resolve(here, "test/helpers/expoCryptoNode.ts"),
      "@web": path.resolve(here, "../src"),
    },
  },
});
