import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { JOURNAL_LAST_IDX, MIGRATIONS } from "../../src/core/generated/migrations";

const dir = path.resolve(__dirname, "../../../backend/src/infrastructure/orm/sqlite/migrations");
const journal = JSON.parse(readFileSync(path.join(dir, "meta", "_journal.json"), "utf8")) as {
  entries: { idx: number; tag: string }[];
};

describe("bundled migrations", () => {
  it("has the journal's count, tags and order", () => {
    expect(MIGRATIONS.map((m) => m.tag)).toEqual(journal.entries.map((e) => e.tag));
    expect(MIGRATIONS.map((m) => m.idx)).toEqual(journal.entries.map((e) => e.idx));
    expect(JOURNAL_LAST_IDX).toBe(journal.entries.at(-1)?.idx);
    expect(MIGRATIONS.length).toBe(10);
  });

  it("each bundled SQL equals its file", () => {
    for (const m of MIGRATIONS) {
      expect(m.sql).toBe(readFileSync(path.join(dir, `${m.tag}.sql`), "utf8"));
    }
  });
});
