/**
 * PostgreSQL sequences for non-primary-key serial columns on the desktop engine
 * (specs/001-desktop-sqlite-engine T034/T041): `sync_outbox.seq` and
 * `sync_inbox.received_seq` (`bigserial`, not the PK).
 *
 * Values come from `motard_sequences` on the bound connection, so every row of a
 * multi-row INSERT gets its own strictly increasing value and `RETURNING` sees
 * it — like `nextval()`. Serial primary keys use `INTEGER PRIMARY KEY
 * AUTOINCREMENT` instead. One delta: a PG sequence value consumed by a rolled-back
 * insert is skipped, while here it is reused. Only ordering is relied on (outbox
 * replay order), and a rolled-back row is never observed.
 */
import type Database from "better-sqlite3";

let bound: Database.Statement | null = null;
let inTransaction: () => boolean = () => false;

/**
 * Called once by the transaction layer with the writer connection. `isInTransaction`
 * guards the writer: a value drawn outside the write gate would write behind it.
 */
export function bindSequenceConnection(db: Database.Database, isInTransaction: () => boolean): void {
  inTransaction = isInTransaction;
  bound = db.prepare(
    `INSERT INTO motard_sequences (name, value) VALUES (?, 1)
       ON CONFLICT (name) DO UPDATE SET value = value + 1
     RETURNING value`,
  );
}

/** `nextval(name)` on the bound connection (inside the caller's transaction). */
export function nextSequenceValue(name: string): number {
  if (!bound) throw new Error(`NOT_BOUND: sequence ${name} has no SQLite connection (connection layer not initialized)`);
  if (!inTransaction()) throw new Error(`SEQUENCE_OUTSIDE_TX: nextval(${name}) must run inside a SQLite transaction`);
  const row = bound.get(name) as { value: number | bigint };
  return Number(row.value);
}
