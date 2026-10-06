/**
 * The template gate must REJECT dirty templates. Runs verify-pgdata-template.mjs against:
 *   1. the shipped template            → must pass
 *   2. a copy with a customer row added → must fail (business data)
 *   3. a copy whose server was killed with `-m immediate` → must fail (unclean shutdown)
 *   4. a copy with a document_sequences row → must fail (invoice numbering would not start at 1)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  TEMPLATE_DIR,
  TEMPLATE_MANIFEST,
  databaseUrl,
  freePort,
  pgTool,
  run,
  startPostgres,
  stopPostgresClean,
  withClient,
} from "./pgdata-template-lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFY = join(HERE, "verify-pgdata-template.mjs");

function verify(templateDir) {
  return spawnSync(process.execPath, [VERIFY], {
    env: { ...process.env, PGDATA_TEMPLATE_DIR: templateDir },
    encoding: "utf8",
    windowsHide: true,
  });
}

/** Copy the shipped template to <tmp>/postgres/pgdata-template (+ manifest beside it). */
function dirtyCopy() {
  const root = mkdtempSync(join(tmpdir(), "motard-tpl-neg-"));
  const dir = join(root, "pgdata-template");
  cpSync(TEMPLATE_DIR, dir, { recursive: true });
  writeFileSync(join(root, "pgdata-template.manifest.json"), readFileSync(TEMPLATE_MANIFEST));
  return { root, dir };
}

async function mutate(dir, sql, { immediate = false } = {}) {
  const port = await freePort();
  const log = join(dir, "..", "mutate.log");
  startPostgres(dir, port, log);
  await withClient(databaseUrl(port), (c) => c.query(sql));
  if (immediate) run(pgTool("pg_ctl"), ["stop", "-D", dir, "-m", "immediate", "-w"]);
  else stopPostgresClean(dir);
}

test("gate passes on the shipped template", () => {
  const r = verify(TEMPLATE_DIR);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /PASS/);
});

test("gate rejects a template containing business data", async () => {
  const { root, dir } = dirtyCopy();
  try {
    await mutate(
      dir,
      `INSERT INTO parties (tenant_id, kind, name, code, currency)
       SELECT id, 'customer', 'DEMO', 'CUS-2026-0001', 'SYP' FROM tenants LIMIT 1`,
    );
    const r = verify(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /table parties: 1 rows, expected 0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate rejects a template with an advanced invoice sequence", async () => {
  const { root, dir } = dirtyCopy();
  try {
    await mutate(
      dir,
      `INSERT INTO document_sequences (tenant_id, entity_type, prefix, last_number)
       SELECT id, 'invoice', 'INV', 41 FROM tenants LIMIT 1`,
    );
    const r = verify(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /document_sequences/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gate rejects a template that was not shut down cleanly", async () => {
  const { root, dir } = dirtyCopy();
  try {
    await mutate(dir, `SELECT 1`, { immediate: true });
    const r = verify(dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /NOT shut down cleanly|automatic recovery|not properly shut down/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
