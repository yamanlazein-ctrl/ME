import { sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";

/**
 * FIN-09: live suites used `if (!reachable) return;`, so with no database they
 * reported success without asserting anything — a suite could pass vacuously
 * forever while the invariant it guards was broken.
 *
 * Policy:
 *   - CI / any environment that declares DATABASE_URL: an unreachable database
 *     is a HARD FAILURE. A gate that cannot run is not a gate that passed.
 *   - Local machine with no DATABASE_URL: the suite may skip, but visibly
 *     (use `skipUnlessDatabase` / vitest `ctx.skip()`, never a silent return).
 */
export async function databaseReachable(): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch (err) {
    if (process.env.DATABASE_URL) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(
        `DATABASE_URL is set but the database is unreachable — this live suite must not pass vacuously: ${cause}`,
      );
    }
    return false;
  }
}

/** Visible skip when DATABASE_URL is unset (databaseReachable returned false). */
export function skipUnlessDatabase(
  reachable: boolean,
  skip: (reason?: string) => void,
): asserts reachable is true {
  if (!reachable) {
    skip("DATABASE_URL unset — live Postgres suite skipped");
  }
}
