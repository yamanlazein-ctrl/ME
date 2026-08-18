// Guarded, idempotent application of backend migration 0013_db_hardening.sql.
// Postgres does NOT support "ALTER TABLE ADD CONSTRAINT IF NOT EXISTS" or
// "CREATE TRIGGER IF NOT EXISTS" — this script achieves the same safety
// guarantee (safe to re-run, never errors on an already-hardened DB) via
// explicit existence checks (constraint) and DROP-then-CREATE (trigger).
// The SQL bodies themselves are copied verbatim from 0013_db_hardening.sql
// — nothing about the hardening logic itself was changed.
const { Client } = require("pg");

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Usage: DATABASE_URL=postgresql://... node apply-0013-guarded.cjs");
  }
  const c = new Client({ connectionString });
  await c.connect();

  // 1) Non-negative remaining_kg constraint — guarded by an explicit
  //    existence check against pg_constraint (ALTER TABLE ADD CONSTRAINT
  //    has no IF NOT EXISTS clause in PostgreSQL).
  const existing = await c.query(
    "select 1 from pg_constraint where conname = 'ck_remaining_kg_nonnegative'",
  );
  if (existing.rowCount > 0) {
    console.log("SKIP: ck_remaining_kg_nonnegative already exists");
  } else {
    const negRows = await c.query("select count(*)::int as n from rolls where remaining_kg < 0");
    if (negRows.rows[0].n > 0) {
      throw new Error(
        `ABORT: ${negRows.rows[0].n} roll(s) already have negative remaining_kg — ` +
          "the constraint would fail validation. Data cleanup required before applying.",
      );
    }
    await c.query(
      "ALTER TABLE rolls ADD CONSTRAINT ck_remaining_kg_nonnegative CHECK (remaining_kg >= 0)",
    );
    console.log("APPLIED: ck_remaining_kg_nonnegative");
  }

  // 2) Immutable ledger trigger — CREATE OR REPLACE FUNCTION is already
  //    idempotent. CREATE TRIGGER is not, so guard it with DROP TRIGGER IF
  //    EXISTS first (same net effect as "IF NOT EXISTS", safe to re-run).
  await c.query(`
    CREATE OR REPLACE FUNCTION fn_ledger_entries_append_only()
    RETURNS TRIGGER AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'ledger_entries is append-only: DELETE not allowed'
          USING ERRCODE = 'insufficient_privilege';
      END IF;

      IF TG_OP = 'UPDATE' THEN
        IF OLD.status = 'cancelled' THEN
          RAISE EXCEPTION 'ledger_entries: cannot modify already-cancelled rows'
            USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF NEW.status <> 'cancelled' THEN
          RAISE EXCEPTION 'ledger_entries: UPDATE only allowed for cancellation (status→cancelled)'
            USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF NEW.debit <> OLD.debit OR NEW.credit <> OLD.credit
           OR NEW.currency <> OLD.currency OR NEW.party_id <> OLD.party_id
           OR NEW.date <> OLD.date OR NEW.type <> OLD.type
           OR NEW.reference_id <> OLD.reference_id
           OR NEW.reference_type <> OLD.reference_type THEN
          RAISE EXCEPTION 'ledger_entries: financial columns are immutable'
            USING ERRCODE = 'insufficient_privilege';
        END IF;
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  console.log("APPLIED (idempotent): fn_ledger_entries_append_only()");

  await c.query("DROP TRIGGER IF EXISTS trg_ledger_entries_append_only ON ledger_entries");
  await c.query(`
    CREATE TRIGGER trg_ledger_entries_append_only
      BEFORE UPDATE OR DELETE ON ledger_entries
      FOR EACH ROW EXECUTE FUNCTION fn_ledger_entries_append_only();
  `);
  console.log("APPLIED (idempotent): trg_ledger_entries_append_only");

  await c.end();
  console.log("0013 hardening applied successfully.");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
