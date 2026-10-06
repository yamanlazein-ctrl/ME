/**
 * Which engine this vitest run exercises (specs/001-desktop-sqlite-engine T064).
 * `npm test` → PostgreSQL (cloud reference); `npm run test:sqlite` → SQLite (desktop build).
 *
 * Use `pgOnly` ONLY for a check of a PostgreSQL mechanism that has no SQLite counterpart by design
 * (an allowed delta in research.md: RLS → app predicate, GIN → none, pg_catalog / node-pg
 * internals). Each use names the SQLite test that covers the same requirement.
 */
export const isSqliteRun = process.env.DB_ENGINE === "sqlite";
export const pgOnly = isSqliteRun;

/** Column names of a table in the live database of the active engine. */
export async function liveColumns(
  execute: (q: unknown) => Promise<unknown>,
  sqlTag: (strings: TemplateStringsArray, ...v: unknown[]) => unknown,
  table: string,
): Promise<string[]> {
  const res = isSqliteRun
    ? await execute(sqlTag`select name as column_name from pragma_table_info(${table}) order by name`)
    : await execute(
        sqlTag`select column_name from information_schema.columns where table_schema = 'public' and table_name = ${table} order by column_name`,
      );
  return ((res as { rows?: { column_name: string }[] }).rows ?? []).map((r) => r.column_name);
}
