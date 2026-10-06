// PORTED-FROM: src/infrastructure/repositories/PostgresHealthRepository.ts sha256=f5f9b468f3635c5bfcfe378939a4aaccc630bb3f76dd8432bd85b4b5b046c53b
// SQLite twin (specs/001-desktop-sqlite-engine S4). Keep behavior identical to the PG source.
/** PostgreSQL deep-health probes — moved verbatim from health.route.ts (S1). */
import { sql } from "drizzle-orm";
import type { DB } from "../../orm/sqlite/drizzleCompat.js";
import type { IHealthRepository } from "../../../application/ports/IHealthRepository.js";

export class SqliteHealthRepository implements IHealthRepository {
  constructor(private readonly db: DB) {}

  async ping(): Promise<void> {
    await this.db.execute(sql`SELECT 1`);
  }

  async databaseSize(): Promise<string> {
    // pg_size_pretty(pg_database_size(…)) → the same text format over the SQLite file size.
    const sizeResult = await this.db.execute<{ size: number }>(sql`
        SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()`);
    const size = sizeResult.rows[0]?.size;
    return size === undefined ? "unknown" : pgSizePretty(Number(size));
  }
}

/** PostgreSQL 17 `pg_size_pretty(bigint)` (src/backend/utils/adt/dbsize.c, size_pretty_units). */
export function pgSizePretty(bytes: number): string {
  const units = [
    { name: "bytes", limit: 10 * 1024, round: false, bits: 0 },
    { name: "kB", limit: 20 * 1024 - 1, round: true, bits: 10 },
    { name: "MB", limit: 20 * 1024 - 1, round: true, bits: 20 },
    { name: "GB", limit: 20 * 1024 - 1, round: true, bits: 30 },
    { name: "TB", limit: 20 * 1024 - 1, round: true, bits: 40 },
    { name: "PB", limit: 20 * 1024 - 1, round: true, bits: 50 },
  ];
  let size = BigInt(Math.trunc(bytes));
  const halfRounded = (x: bigint) => (x + (x < 0n ? -1n : 1n)) / 2n;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const abs = size < 0n ? -size : size;
    if (abs < BigInt(u.limit) || i === units.length - 1) {
      if (u.round) size = halfRounded(size);
      return `${size} ${u.name}`;
    }
    const next = units[i + 1];
    const shift = next.bits - u.bits - (next.round ? 1 : 0) + (u.round ? 1 : 0);
    size /= 1n << BigInt(shift);
  }
  return `${size} bytes`;
}
