/**
 * Transaction clock for the desktop SQLite engine (specs/001-desktop-sqlite-engine,
 * research I-6 / R6, task T042).
 *
 * PostgreSQL `now()` is fixed for the whole transaction and has microsecond
 * resolution. The code depends on both: outbox units in one transaction share
 * `created_at` (ordered by `seq`), and statement keyset cursors compare
 * `(date, created_at, id)`. SQLite has no such clock, so every timestamp default
 * is drawn from here:
 *   - inside a transaction (bound by the connection layer) → one fixed value;
 *   - outside one → a fresh value, like an autocommit statement in PG.
 * Values are microsecond ISO strings, strictly increasing across draws even when
 * several fall in the same millisecond or the wall clock steps backwards.
 */
import { AsyncLocalStorage } from "node:async_hooks";

let lastMicros = 0n;

/** Strictly increasing microseconds since the epoch (wall clock, never repeating). */
export function nextMonotonicMicros(): bigint {
  const now = BigInt(Date.now()) * 1000n;
  lastMicros = now > lastMicros ? now : lastMicros + 1n;
  return lastMicros;
}

/** Fixed-width UTC text `YYYY-MM-DDTHH:MM:SS.ffffffZ` (sorts chronologically). */
export function formatMicrosUtc(micros: bigint): string {
  const ms = micros / 1000n;
  const rest = micros % 1000n;
  const iso = new Date(Number(ms)).toISOString(); // …SS.mmmZ
  return `${iso.slice(0, -1)}${rest.toString().padStart(3, "0")}Z`;
}

const txClock = new AsyncLocalStorage<{ ts: string }>();

/** Run `fn` with one fixed transaction timestamp (the connection layer calls this at BEGIN). */
export function runWithTransactionClock<T>(fn: () => T, ts: string = formatMicrosUtc(nextMonotonicMicros())): T {
  return txClock.run({ ts }, fn);
}

/** The current transaction's timestamp, or a fresh one outside a transaction (PG `now()`). */
export function transactionTimestamp(): string {
  return txClock.getStore()?.ts ?? formatMicrosUtc(nextMonotonicMicros());
}

/** Inverse of formatMicrosUtc: stored UTC µs text → microseconds since the epoch. */
export function parseMicrosUtc(text: string): bigint {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/.exec(text);
  if (!m) throw new Error(`not a stored timestamptz: ${text}`);
  return BigInt(Date.parse(`${m[1]}Z`)) * 1000n + BigInt(m[2]);
}
