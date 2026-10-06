/**
 * REPAIR-017 / REPAIR-022 — periodic retention sweeps (desktop).
 */
import { logger } from "../config/logger.js";
import { config } from "../config/env.js";

const DEVICE_OUTBOX_RETENTION_DAYS = 90; // §19 Q10

let timer: NodeJS.Timeout | null = null;

export function startRetentionJobs(pool: {
  query: (text: string, values?: unknown[]) => Promise<unknown>;
}): void {
  if (!config.DESKTOP_DEPLOY) return;
  if (timer) return;

  const run = async () => {
    try {
      // REPAIR-017: drop synced outbox rows older than 90 days
      await pool.query(
        `DELETE FROM sync_outbox
          WHERE status = 'synced'
            AND synced_at IS NOT NULL
            AND synced_at < now() - ($1::text || ' days')::interval`,
        [String(DEVICE_OUTBOX_RETENTION_DAYS)],
      );
      // REPAIR-022: sweep expired idempotency keys
      await pool.query(`DELETE FROM idempotency_keys WHERE expires_at < now()`);
      logger.info({ bootId: process.env.MOTARD_BOOT_ID }, "retention sweep ok");
    } catch (err) {
      logger.warn({ err }, "retention sweep failed");
    }
  };

  void run();
  timer = setInterval(() => void run(), 6 * 60 * 60 * 1000);
  timer.unref?.();
}

/**
 * The same sweeps on the desktop SQLite engine (specs/001-desktop-sqlite-engine): identical
 * predicates, with `now() - interval '90 days'` computed from the µs clock.
 */
export function startSqliteRetentionJobs(): void {
  if (!config.DESKTOP_DEPLOY) return;
  if (timer) return;

  const run = async () => {
    try {
      const [{ sql }, { sqliteDb }, clock] = await Promise.all([
        import("drizzle-orm"),
        import("../orm/sqlite/transaction.js"),
        import("../orm/sqlite/clock.js"),
      ]);
      const now = clock.transactionTimestamp();
      const cutoff = clock.formatMicrosUtc(
        clock.parseMicrosUtc(now) - BigInt(DEVICE_OUTBOX_RETENTION_DAYS) * 86_400_000_000n,
      );
      const db = sqliteDb();
      await db.execute(sql`DELETE FROM sync_outbox
          WHERE status = 'synced' AND synced_at IS NOT NULL AND synced_at < ${cutoff}`);
      await db.execute(sql`DELETE FROM idempotency_keys WHERE expires_at < ${now}`);
      logger.info({ bootId: process.env.MOTARD_BOOT_ID }, "retention sweep ok");
    } catch (err) {
      logger.warn({ err }, "retention sweep failed");
    }
  };

  void run();
  timer = setInterval(() => void run(), 6 * 60 * 60 * 1000);
  timer.unref?.();
}
