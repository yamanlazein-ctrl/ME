/**
 * `npm run test:sqlite` (specs/001-desktop-sqlite-engine T064): what a test gets when it imports
 * `@/infrastructure/orm/drizzle.js` under DB_ENGINE=sqlite (see tests/_sqlite/resolvePlugin.ts).
 *
 * The suites were written against PostgreSQL; the SAME assertions now run against the SQLite build:
 *   - `db`, `txDb`, `withTenantTx`, `allowLedgerPartyRemap`, `ambientDb`: the SQLite compat layer
 *     the production twins use;
 *   - `pool`: node-pg's `query(text, values)` shape for the tests' raw SQL. PG-only spellings the
 *     suites use (casts, now(), ILIKE, set_config) are rewritten, and result rows come back the way
 *     node-pg returns them (numeric → text at the column scale, boolean → boolean,
 *     timestamptz → Date, jsonb → object), keyed by the live-schema column type.
 * This adapter is test-only; production code never loads it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql, SQL, StringChunk } from "drizzle-orm";
import {
  db as compatDb,
  withTenantTx as compatWithTenantTx,
  allowLedgerPartyRemap,
  ambientDb,
  runInTransaction as compatRunInTransaction,
} from "@/infrastructure/orm/sqlite/drizzleCompat.js";
import { sqliteDb } from "@/infrastructure/orm/sqlite/transaction.js";
import { toTimestamptzText } from "@/infrastructure/orm/sqlite/types.js";


export type { DB, Tx } from "@/infrastructure/orm/sqlite/drizzleCompat.js";
export { allowLedgerPartyRemap, ambientDb };

const FP = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/infrastructure/orm/migrations/meta/schema-fingerprint.json", import.meta.url)), "utf8"),
) as { tables: Record<string, { columns: Record<string, { type: string }> }> };

/** column name → its PG type, when every table that has the column agrees on the type. */
const COLUMN_TYPE = new Map<string, string | null>();
for (const t of Object.values(FP.tables)) {
  for (const [c, { type }] of Object.entries(t.columns)) {
    const seen = COLUMN_TYPE.get(c);
    COLUMN_TYPE.set(c, seen === undefined || seen === type ? type : null);
  }
}

/** The tables a statement reads (FROM / JOIN / UPDATE / INTO), in order — to type ambiguous names. */
function tablesOf(text: string): string[] {
  return [...text.matchAll(/\b(?:from|join|update|into)\s+"?(\w+)"?/gi)].map((m) => m[1]).filter((t) => t in FP.tables);
}

/** PG type of `col` in this statement: its own tables first, then the global (unambiguous) map. */
function typeIn(col: string, tables: string[]): string | null {
  for (const t of tables) {
    const c = FP.tables[t]?.columns[col];
    if (c) return c.type;
  }
  return COLUMN_TYPE.get(col) ?? null;
}

const scaleOf = (type: string | null) => {
  const m = type ? /^numeric\((\d+),(\d+)\)$/.exec(type) : null;
  return m ? Number(m[2]) : null;
};

function formatScaled(v: bigint, scale: number): string {
  const neg = v < 0n;
  const d = (neg ? -v : v).toString().padStart(scale + 1, "0");
  const body = scale ? `${d.slice(0, -scale)}.${d.slice(-scale)}` : d;
  return neg ? `-${body}` : body;
}

/** One raw row → node-pg's default shapes, by column type. Ambiguous/derived columns pass through. */
function pgShape(row: Record<string, unknown>, tables: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    const type = typeIn(k, tables);
    if (v === null || v === undefined || !type) {
      out[k] = v ?? null;
      continue;
    }
    const num = /^numeric\((\d+),(\d+)\)$/.exec(type);
    if (num && (typeof v === "number" || typeof v === "bigint")) out[k] = formatScaled(BigInt(v), Number(num[2]));
    else if (type === "boolean" && (v === 0 || v === 1 || v === 0n || v === 1n)) out[k] = Number(v) === 1;
    else if (type === "timestamp with time zone" && typeof v === "string") out[k] = new Date(v);
    else if ((type === "jsonb" || type.endsWith("[]")) && typeof v === "string") out[k] = JSON.parse(v);
    else if ((type === "integer" || type === "smallint") && typeof v === "bigint") out[k] = Number(v);
    else if (type === "bigint" && (typeof v === "number" || typeof v === "bigint")) out[k] = String(v);
    else out[k] = v;
  }
  return out;
}

/** PG spellings the test suites use → SQLite. */
function translate(text: string): string | null {
  if (/^\s*select\s+set_config\s*\(/i.test(text)) return null; // RLS GUCs: no RLS on SQLite
  // A cast of a MONEY column reads its decimal value on PG; the SQLite column holds the scaled
  // integer, so the cast becomes the exact equivalent (`::text` → PG numeric text, `::float8`/
  // `::numeric` → the decimal number). Production SQLite SQL has no `::`, so only test SQL changes.
  // PG fills these from a sequence default; the SQLite build fills them in its insert path
  // ($defaultFn → motard_sequences). A test's raw single-row INSERT that omits them gets the next value.
  for (const [table, col] of [["sync_inbox", "received_seq"], ["sync_outbox", "seq"]] as const) {
    const m = new RegExp(`(insert\\s+into\\s+"?${table}"?\\s*)\\(([^)]*)\\)(\\s*values\\s*)`, "i").exec(text);
    if (!m || new RegExp(`\\b${col}\\b`).test(m[2])) continue;
    // Every top-level VALUES tuple gets the next value (row k of the statement → MAX + k).
    const start = m.index + m[0].length;
    let depth = 0;
    let quote = false;
    let row = 0;
    let rest = "";
    for (const ch of text.slice(start)) {
      if (ch === "'") quote = !quote;
      if (!quote && ch === "(" && depth++ === 0) {
        rest += `((SELECT COALESCE(MAX(${col}), 0) + ${++row} FROM ${table}), `;
        continue;
      }
      if (!quote && ch === ")") depth--;
      rest += ch;
    }
    text = `${text.slice(0, m.index)}${m[1]}(${col}, ${m[2]})${m[3]}${rest}`;
  }
  // ARRAY['a','b']::text[] → the JSON array the SQLite build stores for text[]/uuid[].
  text = text.replace(/\bARRAY\s*\[([^\]]*)\]/gi, (_all, items: string) => `json_array(${items})`);
  const tables = tablesOf(text);
  const moneyCast = (ref: string, col: string, cast: string): string | null => {
    const s = scaleOf(typeIn(col, tables));
    if (s === null) return null;
    if (/^text$/i.test(cast)) return `motard_dectext(${ref}, ${s})`;
    if (/^(float8?|double precision|real|numeric(\(\d+,\s*\d+\))?)$/i.test(cast)) return `(${ref} * 1.0 / ${10 ** s})`;
    return null;
  };
  // `sum(col)::float8`, `round(a * b, 2)::float8`: every money column inside the call reads as its
  // decimal value, as PG evaluates it (exact numeric there; within float tolerance here).
  text = text.replace(
    /(\b\w+\((?:[^()]|\([^()]*\))*\))::(float8|float|double precision|real|numeric(?:\(\d+,\s*\d+\))?)(?!\w)/gi,
    (_all, call: string) =>
      call.replace(/((?:"?\w+"?\.)?"?(\w+)"?)(?!\s*\()/g, (ref: string, col: string) => {
        const s = scaleOf(typeIn(col, tables));
        return s === null ? ref : `(${ref} * 1.0 / ${10 ** s})`;
      }),
  );
  text = text.replace(
    /((?:"?\w+"?\.)?"?(\w+)"?)::(text|float8|float|double precision|real|numeric(?:\(\d+,\s*\d+\))?)(?!\w)/gi,
    (all, ref: string, col: string, cast: string) => moneyCast(ref, col, cast) ?? all,
  );
  return text
    .replace(/::(uuid|int|integer|int4|int8|bigint|text|numeric(\(\d+,\s*\d+\))?|date|timestamptz|timestamp|jsonb|json|boolean|bool|float8?|double precision|real|varchar)(\[\])?/gi, "")
    .replace(/\bnow\(\)/gi, "(strftime('%Y-%m-%dT%H:%M:%f','now')||'000Z')")
    .replace(/\bILIKE\b/gi, "LIKE");
}

/** Split a VALUES tuple body on top-level commas (not inside parentheses or quotes). */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = false;
  let cur = "";
  for (const ch of s) {
    if (ch === "'") quote = !quote;
    if (!quote && ch === "(") depth++;
    if (!quote && ch === ")") depth--;
    if (!quote && depth === 0 && ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** "12.5" at scale 2 → "1250" (exact; half away from zero beyond the scale, as PG rounds). */
function scaleLiteral(v: string, scale: number): string {
  const neg = v.startsWith("-");
  const [i, f = ""] = (neg ? v.slice(1) : v).split(".");
  let n = BigInt(i + f.padEnd(scale, "0").slice(0, scale));
  if (f.length > scale && Number(f[scale]) >= 5) n += 1n;
  return `${neg ? "-" : ""}${n}`;
}

/**
 * TEST SQL ONLY (never production statements, whose integer literals are already scaled): a decimal
 * literal written into a money column of a single-row INSERT … VALUES → its scaled integer.
 */
function scaleMoneyLiterals(text: string): string {
  return text.replace(
    /(insert\s+into\s+"?(\w+)"?\s*\(([^)]*)\)\s*values\s*\()([^;]*)\)/i,
    (all, head: string, table: string, cols: string, vals: string) => {
      const names = cols.split(",").map((c) => c.trim().replace(/"/g, ""));
      const parts = splitTopLevel(vals);
      if (parts.length !== names.length) return all;
      const scaled = parts.map((v, i) => {
        const s = scaleOf(FP.tables[table]?.columns[names[i]]?.type ?? null);
        return s !== null && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? ` ${scaleLiteral(v.trim(), s)}` : v;
      });
      return `${head}${scaled.join(",")})`;
    },
  );
}

/** `$n` values bound to money columns of a single-row INSERT → scaled integers (test SQL only). */
function scaleMoneyParams(text: string, values: unknown[]): unknown[] {
  const m = /insert\s+into\s+"?(\w+)"?\s*\(([^)]*)\)\s*values\s*\(([^;]*)\)/i.exec(text);
  if (!m) return values;
  const names = m[2].split(",").map((c) => c.trim().replace(/"/g, ""));
  const parts = splitTopLevel(m[3]);
  if (parts.length !== names.length) return values;
  const out = [...values];
  parts.forEach((p, i) => {
    const ref = /^\s*\$(\d+)(::\w+(\(\d+,\s*\d+\))?)?\s*$/.exec(p);
    const s = scaleOf(FP.tables[m[1]]?.columns[names[i]]?.type ?? null);
    if (!ref || s === null) return;
    const k = Number(ref[1]) - 1;
    const v = out[k];
    if (typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v))) out[k] = BigInt(scaleLiteral(String(v), s));
  });
  return out;
}

function bindValue(v: unknown): unknown {
  if (v instanceof Date) return toTimestamptzText(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  if (Array.isArray(v) || (v && typeof v === "object")) return JSON.stringify(v);
  return v;
}

/** `$1 … $n` text + values → a drizzle SQL object (positional repeats allowed). */
function toSql(text: string, values: unknown[]): SQL {
  const chunks: SQL[] = [];
  let last = 0;
  for (const m of text.matchAll(/\$(\d+)/g)) {
    chunks.push(sql.raw(text.slice(last, m.index)));
    chunks.push(sql`${bindValue(values[Number(m[1]) - 1])}`);
    last = m.index! + m[0].length;
  }
  chunks.push(sql.raw(text.slice(last)));
  return sql.join(chunks, sql.raw(""));
}

async function query<R = Record<string, unknown>>(textOrConfig: string | { text: string; values?: unknown[] }, values: unknown[] = []) {
  const text = typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text;
  const vals = typeof textOrConfig === "string" ? values : (textOrConfig.values ?? values);
  const translated = translate(scaleMoneyLiterals(text));
  if (translated === null) return { rows: [] as R[], rowCount: 0 };
  const r = await sqliteDb().execute(toSql(translated, scaleMoneyParams(text, vals)));
  const tables = tablesOf(text);
  const rows = (r.rows as Record<string, unknown>[]).map((row) => pgShape(row, tables)) as R[];
  return { rows, rowCount: r.rowCount ?? rows.length };
}

const client = { query, release(_destroy?: boolean) {} };

export const pool = {
  query,
  async connect() {
    return client;
  },
  async end() {},
  on() {
    return pool;
  },
};

export async function openDedicatedClient() {
  return { ...client, async end() {} };
}
export async function setTenantForTransaction(): Promise<void> {}
export async function checkDatabase(): Promise<boolean> {
  return (await import("@/infrastructure/orm/engine.js")).checkDatabase();
}

// ─── db / tx: drizzle `sql` objects get the same PG → SQLite rewrite as pool.query ───────────

const BASELINE = readFileSync(
  fileURLToPath(new URL("../../src/infrastructure/orm/sqlite/migrations/0000_baseline.sql", import.meta.url)),
  "utf8",
);
/** The SQLite statements of the append-only guard (PG: one trigger, trg_ledger_entries_append_only). */
const APPEND_ONLY_DDL = [...BASELINE.matchAll(/CREATE TRIGGER "trg_ledger_entries_append_only_b[du]"[\s\S]*?\nEND;/g)].map((m) => m[0]);

/** Test DDL that has a different spelling on SQLite; null = not special. */
function specialStatement(text: string): string[] | null {
  if (/^\s*select\s+set_config\s*\(/i.test(text)) return []; // RLS GUCs: no RLS on SQLite
  if (/^\s*DROP TRIGGER IF EXISTS trg_ledger_entries_append_only ON ledger_entries\s*$/i.test(text))
    return ["DROP TRIGGER IF EXISTS trg_ledger_entries_append_only_bd", "DROP TRIGGER IF EXISTS trg_ledger_entries_append_only_bu"];
  if (/^\s*CREATE OR REPLACE TRIGGER trg_ledger_entries_append_only\b/i.test(text))
    return [
      "DROP TRIGGER IF EXISTS trg_ledger_entries_append_only_bd",
      "DROP TRIGGER IF EXISTS trg_ledger_entries_append_only_bu",
      ...APPEND_ONLY_DDL,
    ];
  return null;
}

function rewrite(q: SQL): SQL {
  return new SQL(
    q.queryChunks.map((c) => {
      if (c instanceof StringChunk) return new StringChunk(translate(c.value.join("")) ?? "SELECT 1 WHERE 0");
      if (c instanceof SQL) return rewrite(c);
      return c;
    }),
  );
}

function rawText(q: SQL): string {
  return q.queryChunks.map((c) => (c instanceof StringChunk ? c.value.join("") : c instanceof SQL ? rawText(c) : "?")).join("");
}

/** `?` placeholders (outside string literals) → `$1 … $n`. */
function toDollarParams(text: string): string {
  let n = 0;
  let quote = false;
  let out = "";
  for (const ch of text) {
    if (ch === "'") quote = !quote;
    out += !quote && ch === "?" ? `$${++n}` : ch;
  }
  return out;
}

/** The first stack frame outside this shim: a test file (tests/**) or production code (src/**). */
function calledFromTest(stack: string): boolean {
  for (const line of stack.split("\n").slice(1)) {
    const f = line.replace(/\\/g, "/");
    if (f.includes("/tests/_sqlite/") || f.includes("node_modules") || !/\/(tests|src)\//.test(f)) continue;
    return f.includes("/tests/");
  }
  return false;
}

type Handle = typeof compatDb;
function wrap(base: Handle): Handle {
  return new Proxy(base, {
    get(target, prop) {
      if (prop === "execute") {
        return async (q: SQL) => {
          if (q instanceof SQL) {
            const special = specialStatement(rawText(q));
            if (special) {
              for (const stmt of special) await target.execute(sql.raw(stmt));
              return { rows: [], rowCount: 0 };
            }
            // Only a test's OWN raw read gets node-pg shapes (numeric → text, bool, Date, json), as
            // db.execute() returned on PostgreSQL. A SQLite repository handed this db by the test reads
            // its raw values, exactly as in production.
            // The test's own statement: rendered to `$n` text + params and run like pool.query (money
            // literals/params scaled, rows shaped). Production code handed this db runs untouched.
            if (calledFromTest(new Error().stack ?? "")) {
              const rendered = (target as unknown as { dialect: { sqlToQuery(q: SQL): { sql: string; params: unknown[] } } }).dialect.sqlToQuery(q);
              return query(toDollarParams(rendered.sql), rendered.params);
            }
            return target.execute(rewrite(q));
          }
          return target.execute(q);
        };
      }
      if (prop === "transaction") {
        return (fn: (tx: Handle) => Promise<unknown>, ...rest: unknown[]) =>
          (target.transaction as (...a: unknown[]) => Promise<unknown>)((tx: Handle) => fn(wrap(tx)), ...rest);
      }
      const v = (target as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

export const db = wrap(compatDb);
export const txDb = db;
export const withTenantTx: typeof compatWithTenantTx = (tenantId, fn) => compatWithTenantTx(tenantId, (tx) => fn(wrap(tx)));
export const runInTransaction: typeof compatRunInTransaction = (fn) => compatRunInTransaction((tx) => fn(wrap(tx)));

// Every statement — raw, \`sql\` fragments inside query builders, production twins — is prepared
// here. Rewriting at this one point covers the suites' PG spellings wherever they appear; the
// SQLite build's own SQL contains none of them, so for it this is the identity.
{
  const Database = (await import("better-sqlite3")).default;
  const proto = Database.prototype as unknown as { prepare: (src: string) => unknown; __motardPatched?: boolean };
  if (!proto.__motardPatched) {
    const prepare = proto.prepare;
    proto.prepare = function (this: unknown, src: string) {
      return prepare.call(this, translate(src) ?? "SELECT 1 WHERE 0");
    };
    proto.__motardPatched = true;
  }
}

// Boot (or reopen) this run's SQLite file before any handle is used — what server.ts does at start.
await (await import("@/infrastructure/orm/sqlite/runtime.js")).ensureSqliteRuntime();
