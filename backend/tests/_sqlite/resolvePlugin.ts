/**
 * Vite resolver for `npm run test:sqlite` (specs/001-desktop-sqlite-engine T064).
 *
 * Applies ONLY to imports made by test files (tests/**, not tests/sqlite/**, not src/**): the PG
 * module a suite names is swapped for its SQLite twin, so the unchanged suite exercises the
 * SQLite build with the same assertions.
 *   orm/drizzle               → tests/_sqlite/drizzleShim.ts
 *   orm/schemas/<t>.table     → orm/sqlite/schemas/<t>.table
 *   orm/schemas (index)       → orm/sqlite/schemas/index
 *   repositories/PostgresX    → repositories/sqlite/SqliteX, re-exported under the PG names
 *   repositories/<helper>     → repositories/sqlite/helpers/<helper>
 *   utils/documentNumbers     → repositories/sqlite/helpers/documentNumbers
 * Everything else resolves normally.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import type { Plugin } from "vite";

const VIRTUAL = "\0motard-sqlite-twin:";

export function sqliteTwinResolver(backendRoot: string): Plugin {
  const src = join(backendRoot, "src");
  const tests = join(backendRoot, "tests");
  const own = [join(tests, "sqlite"), join(tests, "_sqlite")];
  const repoDir = join(src, "infrastructure", "repositories");
  const sqliteRepoDir = join(repoDir, "sqlite");

  const strip = (p: string) => p.replace(/\.(js|ts)$/, "");
  const ts = (p: string) => (existsSync(`${p}.ts`) ? `${p}.ts` : null);

  return {
    name: "motard-sqlite-twin-resolver",
    enforce: "pre",
    async resolveId(source, importer) {
      if (!importer || source.startsWith(VIRTUAL)) return null;
      const imp = normalize(importer);
      if (!imp.startsWith(tests + sep) || own.some((d) => imp.startsWith(d + sep))) return null;
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      if (!resolved) return null;
      const id = strip(normalize(resolved.id.split("?")[0]));
      const rel = id.startsWith(src + sep) ? id.slice(src.length + 1).split(sep).join("/") : null;
      if (!rel) return null;

      if (rel === "infrastructure/orm/drizzle") return join(tests, "_sqlite", "drizzleShim.ts");
      let m = /^infrastructure\/orm\/schemas\/(.+)$/.exec(rel);
      if (m) return ts(join(src, "infrastructure", "orm", "sqlite", "schemas", m[1])) ?? null;
      if (rel === "infrastructure/orm/schemas") return ts(join(src, "infrastructure", "orm", "sqlite", "schemas", "index"));
      if (rel === "infrastructure/utils/documentNumbers") return ts(join(sqliteRepoDir, "helpers", "documentNumbers"));
      m = /^infrastructure\/repositories\/Postgres(\w+)$/.exec(rel);
      if (m && ts(join(sqliteRepoDir, `Sqlite${m[1]}`))) return `${VIRTUAL}${m[1]}`;
      m = /^infrastructure\/repositories\/(\w+)$/.exec(rel);
      if (m) return ts(join(sqliteRepoDir, "helpers", m[1])) ?? null;
      return null;
    },
    load(id) {
      if (!id.startsWith(VIRTUAL)) return null;
      const name = id.slice(VIRTUAL.length);
      const twin = join(sqliteRepoDir, `Sqlite${name}.ts`);
      const text = readFileSync(twin, "utf8");
      const aliases = new Set<string>();
      for (const [, n] of text.matchAll(/^export\s+(?:class|const|function|async function)\s+(\w+)/gm)) {
        const pg = n.replace(/^Sqlite/, "Postgres").replace(/^sqlite/, "postgres");
        if (pg !== n) aliases.add(`export { ${n} as ${pg} };`);
      }
      const spec = twin.split(sep).join("/");
      const names = [...text.matchAll(/^export\s+(?:class|const|function|async function)\s+(\w+)/gm)].map((x) => x[1]);
      return [`export * from ${JSON.stringify(spec)};`, `import { ${names.join(", ")} } from ${JSON.stringify(spec)};`, ...aliases].join("\n");
    },
  };
}
