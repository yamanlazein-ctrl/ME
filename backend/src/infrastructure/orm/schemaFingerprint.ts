/**
 * REPAIR-025 — live schema fingerprint read + diff (runtime verifier).
 * Build-time generator: backend/scripts/schema-fingerprint.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type SchemaFingerprint = {
  journalIdx: number;
  generatedAt: string;
  sha256: string;
  tables: Record<string, { columns: Record<string, { type: string; nullable: boolean; default: string | null }> }>;
  indexes: Record<string, { table: string; definition: string }>;
  constraints: Record<string, { table: string; type: string; definition: string }>;
  policies: Record<string, { cmd: string; using: string | null; withCheck: string | null }>;
  rls: Record<string, { enabled: boolean; forced: boolean }>;
  triggers: Record<string, { table: string; definition: string }>;
  functions: Record<string, string>;
  enums: Record<string, string[]>;
  extensions: string[];
};

export type FingerprintDiff = {
  missing: string[];
  extra: string[];
  changed: string[];
};

type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

function normalizeDef(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

export function canonicalJson(fp: Omit<SchemaFingerprint, "sha256" | "generatedAt">): string {
  return JSON.stringify(fp, Object.keys(fp).sort());
}

export function fingerprintSha256(fp: Omit<SchemaFingerprint, "sha256" | "generatedAt">): string {
  return createHash("sha256").update(canonicalJson(fp)).digest("hex");
}

export function diffFingerprint(
  expected: SchemaFingerprint,
  live: SchemaFingerprint,
): FingerprintDiff {
  const missing: string[] = [];
  const extra: string[] = [];
  const changed: string[] = [];

  const cats: Array<keyof Pick<SchemaFingerprint, "tables" | "indexes" | "constraints" | "policies" | "rls" | "triggers" | "functions" | "enums">> = [
    "tables",
    "indexes",
    "constraints",
    "policies",
    "rls",
    "triggers",
    "functions",
    "enums",
  ];

  for (const cat of cats) {
    const e = expected[cat] as Record<string, unknown>;
    const l = live[cat] as Record<string, unknown>;
    for (const k of Object.keys(e)) {
      if (!(k in l)) missing.push(`${cat}.${k}`);
      else if (JSON.stringify(e[k]) !== JSON.stringify(l[k])) {
        // Normalize definition strings for indexes/constraints/triggers
        if (
          cat === "indexes" ||
          cat === "constraints" ||
          cat === "triggers"
        ) {
          const ed = (e[k] as { definition?: string }).definition;
          const ld = (l[k] as { definition?: string }).definition;
          if (ed && ld && normalizeDef(ed) === normalizeDef(ld)) continue;
        }
        changed.push(`${cat}.${k}`);
      }
    }
    for (const k of Object.keys(l)) {
      if (!(k in e)) extra.push(`${cat}.${k}`);
    }
  }

  for (const ext of expected.extensions) {
    if (!live.extensions.includes(ext)) missing.push(`extensions.${ext}`);
  }
  for (const ext of live.extensions) {
    if (!expected.extensions.includes(ext)) extra.push(`extensions.${ext}`);
  }

  return { missing, extra, changed };
}

export async function readLiveFingerprint(db: Queryable): Promise<SchemaFingerprint> {
  const tablesRes = await db.query(`
    SELECT c.relname AS table_name, a.attname AS column_name,
           pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
           NOT a.attnotnull AS nullable,
           pg_get_expr(ad.adbin, ad.adrelid) AS col_default
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY c.relname, a.attnum`);

  const tables: SchemaFingerprint["tables"] = {};
  for (const row of tablesRes.rows) {
    const t = String(row.table_name);
    tables[t] ??= { columns: {} };
    tables[t]!.columns[String(row.column_name)] = {
      type: String(row.data_type),
      nullable: Boolean(row.nullable),
      default: row.col_default == null ? null : String(row.col_default),
    };
  }

  const idxRes = await db.query(`
    SELECT indexname, tablename, indexdef FROM pg_indexes WHERE schemaname = 'public'`);
  const indexes: SchemaFingerprint["indexes"] = {};
  for (const row of idxRes.rows) {
    indexes[String(row.indexname)] = {
      table: String(row.tablename),
      definition: normalizeDef(String(row.indexdef)),
    };
  }

  const conRes = await db.query(`
    SELECT con.conname, rel.relname AS table_name, con.contype,
           pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace
     WHERE n.nspname = 'public'`);
  const constraints: SchemaFingerprint["constraints"] = {};
  for (const row of conRes.rows) {
    constraints[String(row.conname)] = {
      table: String(row.table_name),
      type: String(row.contype),
      definition: normalizeDef(String(row.definition)),
    };
  }

  const polRes = await db.query(`
    SELECT schemaname||'.'||tablename||'.'||policyname AS key, cmd, qual, with_check
      FROM pg_policies WHERE schemaname = 'public'`);
  const policies: SchemaFingerprint["policies"] = {};
  for (const row of polRes.rows) {
    policies[String(row.key)] = {
      cmd: String(row.cmd),
      using: row.qual == null ? null : String(row.qual),
      withCheck: row.with_check == null ? null : String(row.with_check),
    };
  }

  const rlsRes = await db.query(`
    SELECT c.relname, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'`);
  const rls: SchemaFingerprint["rls"] = {};
  for (const row of rlsRes.rows) {
    rls[String(row.relname)] = { enabled: Boolean(row.enabled), forced: Boolean(row.forced) };
  }

  const trgRes = await db.query(`
    SELECT t.tgname, c.relname AS table_name, pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal`);
  const triggers: SchemaFingerprint["triggers"] = {};
  for (const row of trgRes.rows) {
    triggers[String(row.tgname)] = {
      table: String(row.table_name),
      definition: normalizeDef(String(row.definition)),
    };
  }

  const fnRes = await db.query(`
    SELECT p.proname, p.prosrc FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'`);
  const functions: SchemaFingerprint["functions"] = {};
  for (const row of fnRes.rows) {
    functions[String(row.proname)] = createHash("sha256")
      .update(String(row.prosrc ?? ""))
      .digest("hex");
  }

  const enumRes = await db.query(`
    SELECT t.typname, e.enumlabel
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public'
     ORDER BY t.typname, e.enumsortorder`);
  const enums: SchemaFingerprint["enums"] = {};
  for (const row of enumRes.rows) {
    const name = String(row.typname);
    enums[name] ??= [];
    enums[name]!.push(String(row.enumlabel));
  }

  const extRes = await db.query(`SELECT extname FROM pg_extension ORDER BY 1`);
  const extensions = extRes.rows.map((r) => String(r.extname));

  const body = {
    journalIdx: 0,
    tables,
    indexes,
    constraints,
    policies,
    rls,
    triggers,
    functions,
    enums,
    extensions,
  };
  const sha256 = fingerprintSha256(body);
  return { ...body, generatedAt: new Date().toISOString(), sha256 };
}

export function loadCommittedFingerprint(migrationsFolder?: string): SchemaFingerprint | null {
  const folder =
    migrationsFolder ??
    process.env.DESKTOP_MIGRATIONS_FOLDER ??
    join(dirname(fileURLToPath(import.meta.url)), "migrations");
  const path = join(folder, "meta", "schema-fingerprint.json");
  if (!existsSync(path)) return null;
  const fp = JSON.parse(readFileSync(path, "utf8")) as SchemaFingerprint & { note?: string };
  // Placeholder from REPAIR-025 until `schema-fingerprint.mjs` is run against a migrated DB.
  if (fp.sha256 === "pending-generate" || Object.keys(fp.tables ?? {}).length === 0) {
    return null;
  }
  return fp;
}
