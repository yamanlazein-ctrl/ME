/**
 * The desktop pre-migration pg_dump snapshot must run only when this boot
 * will actually apply a migration (it used to dump the whole DB every boot).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { hasPendingMigrations } from "../src/infrastructure/orm/runDesktopMigrations.js";

const folder = path.resolve(__dirname, "../src/infrastructure/orm/migrations");
const entries = (
  JSON.parse(readFileSync(path.join(folder, "meta", "_journal.json"), "utf8")) as {
    entries: Array<{ when: number }>;
  }
).entries;
const newest = Math.max(...entries.map((e) => Number(e.when)));

describe("hasPendingMigrations", () => {
  it("fresh cluster (nothing applied) has pending migrations", () => {
    expect(hasPendingMigrations(folder, 0)).toBe(true);
  });
  it("fully migrated cluster has none", () => {
    expect(hasPendingMigrations(folder, newest)).toBe(false);
  });
  it("one release behind has pending migrations", () => {
    const secondNewest = [...entries.map((e) => Number(e.when))].sort((a, b) => b - a)[1]!;
    expect(hasPendingMigrations(folder, secondNewest)).toBe(true);
  });
});
