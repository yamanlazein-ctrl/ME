#!/usr/bin/env node
/**
 * Mechanical first pass of the SQLite repository port (specs/001-desktop-sqlite-engine T053–T061).
 *
 *   node scripts/port-sqlite-repos.mjs <file.ts> [...]      write the SQLite copy (refuses to overwrite)
 *   node scripts/port-sqlite-repos.mjs --check              report SQLite copies whose PG source changed
 *
 * For src/infrastructure/repositories/PostgresX.ts → repositories/sqlite/SqliteX.ts, and for the
 * repository helpers (non-Postgres files) → repositories/sqlite/helpers/<same>.ts:
 *   - imports re-pointed: tables → orm/sqlite/schemas, DB/Tx → SqliteDb, ported siblings → their copies;
 *   - Postgres* identifiers → Sqlite*;
 *   - `.for("update")` row locks removed (the write gate serializes every writer);
 *   - `ilike(col, pattern)` → `ilikeEscaped(col, pattern)` (LIKE … ESCAPE '\', research R7).
 * Everything PG-specific that remains (casts, execute(), money arithmetic) is fixed by hand and
 * reviewed; the header records the PG source sha256 so `--check` detects later drift.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../src/infrastructure/repositories");
const OUT = join(REPO, "sqlite");
const sha = (s) => createHash("sha256").update(s).digest("hex");

/** Repository-dir helpers that get SQLite twins in sqlite/helpers/. */
const HELPERS = new Set(
  readdirSync(REPO).filter((f) => f.endsWith(".ts") && !f.startsWith("Postgres") && f !== "engineStores.ts"),
);
/** Infrastructure utils with SQL that get SQLite twins in sqlite/helpers/. */
const UTIL_TWINS = new Set(["documentNumbers.ts"]);

function targetOf(src) {
  const b = basename(src);
  if (b.startsWith("Postgres")) return join(OUT, b.replace(/^Postgres/, "Sqlite"));
  return join(OUT, "helpers", b);
}

function rewrite(src, text) {
  const isHelper = !basename(src).startsWith("Postgres");
  const up = isHelper ? "../../../" : "../../"; // from sqlite/ or sqlite/helpers/ back to src/infrastructure/
  const fromUtils = src.includes(`${"utils"}`);
  let t = text;
  t = t.replace(/from "(\.\.?\/[^"]+)"/g, (m, spec) => {
    // resolve the spec relative to the PG source, then re-point
    const abs = resolve(dirname(src), spec);
    const relInfra = relative(resolve(REPO, ".."), abs).replace(/\\/g, "/"); // e.g. orm/schemas/party.table.js
    const b = basename(abs).replace(/\.js$/, ".ts");
    if (relInfra.startsWith("orm/schemas/")) return `from "${up}orm/sqlite/schemas/${relInfra.slice("orm/schemas/".length)}"`;
    if (relInfra === "orm/drizzle.js") return `from "${up}orm/sqlite/drizzleCompat.js"`;
    if (relInfra.startsWith("repositories/")) {
      const f = relInfra.slice("repositories/".length);
      if (f.startsWith("Postgres")) return `from "${isHelper ? "../" : "./"}${f.replace(/^Postgres/, "Sqlite")}"`;
      if (HELPERS.has(b)) return `from "${isHelper ? "./" : "./helpers/"}${f}"`;
      return `from "${up}repositories/${f}"`;
    }
    if (relInfra.startsWith("utils/") && UTIL_TWINS.has(b)) return `from "${isHelper ? "./" : "./helpers/"}${b.replace(/\.ts$/, ".js")}"`;
    if (relInfra.startsWith("..")) return `from "${up}${relInfra}"`; // application/, domain/ (relative to src/infrastructure)
    return `from "${up}${relInfra}"`;
  });
  void fromUtils;
  t = t.replace(/\bPostgres([A-Z][A-Za-z]+)/g, "Sqlite$1");
  t = t.replace(/\n(\s*)\.for\("(?:no key )?update"(?:,\s*\{[^}]*\})?\)/g, "");
  t = t.replace(/\.for\("(?:no key )?update"(?:,\s*\{[^}]*\})?\)/g, "");
  if (/\bilike\(/.test(t)) {
    t = t.replace(/\bilike\(/g, "ilikeEscaped(");
    t = t.replace(/(import \{[^}]*)\bilike,\s*/, "$1");
    t = t.replace(/(import \{[^}]*),\s*ilike\b/, "$1");
    const helperPath = isHelper ? "./likeContains.js" : "./helpers/likeContains.js";
    t = `import { ilikeEscaped } from "${helperPath}";\n` + t;
  }
  t = t.replace(/\btype DB\b/g, "type DB").replace(/\btype Tx\b/g, "type Tx");
  return t;
}

if (process.argv.includes("--check")) {
  let drift = 0;
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  for (const f of walk(OUT).filter((p) => p.endsWith(".ts"))) {
    const m = /PORTED-FROM: (\S+) sha256=([0-9a-f]{64})/.exec(readFileSync(f, "utf8"));
    if (!m) continue;
    const srcPath = resolve(here, "..", m[1]);
    if (!existsSync(srcPath) || sha(readFileSync(srcPath, "utf8")) !== m[2]) {
      console.error(`drift: ${relative(resolve(here, ".."), f)} — its PG source ${m[1]} changed; review and re-stamp`);
      drift++;
    }
  }
  console.log(drift ? `${drift} SQLite twin(s) need review` : "no drift: every SQLite twin matches its PG source");
  process.exit(drift ? 1 : 0);
}

for (const arg of process.argv.slice(2)) {
  const src = resolve(arg);
  const text = readFileSync(src, "utf8");
  const target = targetOf(src);
  if (existsSync(target)) {
    console.log(`skip (exists): ${relative(process.cwd(), target)}`);
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  const relSrc = relative(resolve(here, ".."), src).replace(/\\/g, "/");
  const header = `// PORTED-FROM: ${relSrc} sha256=${sha(text)}\n// SQLite twin (specs/001-desktop-sqlite-engine S4). Keep behavior identical to the PG source.\n`;
  writeFileSync(target, header + rewrite(src, text));
  console.log(`wrote ${relative(process.cwd(), target)}`);
}
