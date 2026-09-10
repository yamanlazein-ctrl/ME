/**
 * RLS regression guards (Phase F — docs/decisions.md D-006).
 *
 * These are STATIC, database-free tests. They lock in the invariants that keep
 * row-level security part of the project's source of truth:
 *
 *  1. Every business table in the TS schema declares `.enableRLS()` — so
 *     `drizzle-kit push` provisions RLS with the table and can never silently
 *     create (or re-create) an unprotected table. Live proof: pushing this
 *     schema to an empty database produced 38/39 RLS-enabled tables
 *     (the 39th is the exempt `schema_migrations` bookkeeping table).
 *  2. The only place that may import `pg` or open a Pool/Client is
 *     `src/infrastructure/orm/drizzle.ts` — the TenantScopedPool that stamps
 *     `app.current_tenant_id` / `app.platform_mode` on EVERY checkout. Any
 *     direct database access outside it would bypass RLS stamping.
 *  3. Tenant-GUC writes (`set_config`, `SET app.*`) are confined to
 *     drizzle.ts — ad-hoc GUC spoofing elsewhere would defeat isolation.
 *  4. `enable-rls.sql` keeps the NULLIF guard on every tenant GUC cast and
 *     still declares the four canonical policy families.
 *  5. Every TS business table is covered by `enable-rls.sql` (policy layer),
 *     so a table can't be added to the schema and forgotten in the RLS SQL.
 *  6. `db:push` stays a guarded scratch-only script — no bare `db:push`
 *     convenience script may be reintroduced.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS_DIR = join(BACKEND_ROOT, "src", "infrastructure", "orm", "schemas");
const RLS_SQL = join(BACKEND_ROOT, "src", "infrastructure", "orm", "rls", "enable-rls.sql");
const SRC_DIR = join(BACKEND_ROOT, "src");

/** Internal bookkeeping tables intentionally NOT RLS-managed. */
const RLS_EXEMPT_TABLES = new Set(["schema_migrations", "__drizzle_migrations"]);

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return listTsFiles(p);
    return e.isFile() && e.name.endsWith(".ts") ? [p] : [];
  });
}

/** Resolve every `pgTable(` call to its balanced closing paren. */
function extractTableCalls(src: string): { name: string; start: number; end: number }[] {
  const out: { name: string; start: number; end: number }[] = [];
  for (const m of src.matchAll(/\bpgTable\(/g)) {
    const start = m.index;
    const open = start + "pgTable".length;
    let depth = 0;
    let end = -1;
    for (let i = open; i < src.length; i++) {
      const ch = src[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) throw new Error(`unbalanced parentheses in pgTable call at offset ${start}`);
    const nameMatch = src.slice(start, end + 1).match(/pgTable\(\s*"([a-z_]+)"/);
    if (!nameMatch) throw new Error(`cannot resolve table name in pgTable call at offset ${start}`);
    out.push({ name: nameMatch[1], start, end });
  }
  return out;
}

function schemaTables(): { file: string; name: string; call: string; end: number }[] {
  return readdirSync(SCHEMAS_DIR)
    .filter((f) => f.endsWith(".table.ts"))
    .flatMap((f) => {
      const src = readFileSync(join(SCHEMAS_DIR, f), "utf8");
      return extractTableCalls(src).map((t) => ({ file: f, name: t.name, call: src.slice(t.start, t.end + 1), end: t.end }));
    });
}

describe("RLS regression guards (Phase F, D-006)", () => {
  it("every business table declares .enableRLS() in the TS schema", () => {
    const tables = schemaTables();
    expect(tables.length).toBeGreaterThanOrEqual(38);

    const missing = tables
      .filter((t) => !RLS_EXEMPT_TABLES.has(t.name))
      .filter((t) => !/^\s*\.enableRLS\(\)/.test(readFileSync(join(SCHEMAS_DIR, t.file), "utf8").slice(t.end + 1, t.end + 40)))
      .map((t) => `${t.file} → ${t.name}`);

    expect(missing, `tables without .enableRLS():\n${missing.join("\n")}`).toEqual([]);
  });

  it("exempt bookkeeping tables are not RLS-managed (sanity on the exempt list)", () => {
    const tables = schemaTables();
    // schema_migrations must stay in TS and stay exempt.
    const internal = tables.filter((t) => RLS_EXEMPT_TABLES.has(t.name)).map((t) => t.name);
    expect(internal).toContain("schema_migrations");
    expect(internal.every((n) => !n.includes(".enableRLS()"))).toBe(true);
  });

  it("every TS business table is covered by enable-rls.sql", () => {
    const sql = readFileSync(RLS_SQL, "utf8");
    const uncovered = schemaTables()
      .filter((t) => !RLS_EXEMPT_TABLES.has(t.name))
      // enable-rls.sql quotes table names either as SQL string literals
      // ('table_name' in the category lists) or as identifiers ("table_name").
      .filter((t) => !sql.includes(`'${t.name}'`) && !sql.includes(`"${t.name}"`))
      .map((t) => t.name);

    expect(uncovered, `tables missing from enable-rls.sql: ${uncovered.join(", ")}`).toEqual([]);
  });

  it("only drizzle.ts may import pg or open a Pool/Client", () => {
    const offenders: string[] = [];
    for (const f of listTsFiles(SRC_DIR)) {
      const rel = relative(BACKEND_ROOT, f).replaceAll("\\", "/");
      if (rel === "src/infrastructure/orm/drizzle.ts") continue;
      const src = readFileSync(f, "utf8");
      if (/\bfrom\s+["']pg["']/.test(src) || /\bimport\s*\(\s*["']pg["']\s*\)/.test(src))
        offenders.push(`${rel}: imports "pg"`);
      if (/\bnew\s+Pool\s*\(/.test(src)) offenders.push(`${rel}: new Pool()`);
      if (/\bnew\s+Client\s*\(/.test(src)) offenders.push(`${rel}: new Client()`);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("tenant-GUC writes are confined to drizzle.ts", () => {
    const offenders: string[] = [];
    for (const f of listTsFiles(SRC_DIR)) {
      const rel = relative(BACKEND_ROOT, f).replaceAll("\\", "/");
      if (rel === "src/infrastructure/orm/drizzle.ts") continue;
      const src = readFileSync(f, "utf8");
      if (/set_config\s*\(/.test(src)) offenders.push(`${rel}: set_config()`);
      if (/\bSET\s+(LOCAL\s+)?app\./i.test(src)) offenders.push(`${rel}: SET app.*`);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("enable-rls.sql keeps the NULLIF guard on every tenant GUC cast", () => {
    const sql = readFileSync(RLS_SQL, "utf8");

    // Legacy unguarded casts — must not (re)appear in any form:
    //   current_setting('app.current_tenant_id')::uuid
    //   current_setting(''app.current_tenant_id'', true)::uuid  (no NULLIF)
    const unguarded =
      /(?<!NULLIF\()current_setting\((?:''|')app\.current_tenant_id(?:''|')(?:,\s*(?:missing_ok\s*=\s*)?true)?\)\s*::uuid/g;
    const hits = [...sql.matchAll(unguarded)].map((m) => sql.slice(Math.max(0, m.index - 60), m.index + m[0].length));
    expect(hits, hits.join("\n---\n")).toEqual([]);

    // The guarded form must actually be present (guards not silently dropped).
    expect(sql).toContain("NULLIF(current_setting(''app.current_tenant_id'', true), '''')");
  });

  it("enable-rls.sql declares the four canonical policy families", () => {
    const sql = readFileSync(RLS_SQL, "utf8");
    for (const policy of ["tenant_isolation", "platform_or_tenant", "tenant_directory", "platform_only"]) {
      expect(sql, `missing policy family: ${policy}`).toContain(policy);
    }
  });

  it("db:push stays a guarded scratch-only script", () => {
    const pkg = JSON.parse(readFileSync(join(BACKEND_ROOT, "package.json"), "utf8"));
    const scripts: Record<string, string> = pkg.scripts ?? {};

    expect(scripts, "bare db:push script must not be reintroduced — use db:push:scratch").not.toHaveProperty("db:push");

    const scratch = scripts["db:push:scratch"];
    expect(scratch, "db:push:scratch must keep its WARNING preamble").toMatch(/WARNING/i);
  });
});
