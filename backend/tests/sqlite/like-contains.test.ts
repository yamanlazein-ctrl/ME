/**
 * T052: `LIKE … ESCAPE '\'` with the shared likeContains() pattern matches exactly what PG
 * ILIKE matches (locale C): metacharacters in the input are literal, ASCII case folds,
 * Arabic and other non-ASCII text matches as-is.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { ilikeContains } from "@/infrastructure/repositories/sqlite/helpers/likeContains.js";

const names = ["100%_pure", "100 pure", "a\\b", "ab", "Ahmad", "AHMAD trade", "أحمد للأقمشة", "محمد", "x_y", "xay", "Éclair", "éclair"];

describe("ilikeContains (T052)", () => {
  const raw = new Database(":memory:");
  raw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
  const t = sqliteTable("t", { id: integer("id").primaryKey(), name: text("name").notNull() });
  const db = drizzle(raw);
  db.insert(t).values(names.map((name, i) => ({ id: i, name }))).run();
  const find = (q: string) => db.select({ name: t.name }).from(t).where(ilikeContains(t.name, q)).all().map((r) => r.name).sort();

  it("treats %, _ and \\ in the input literally", () => {
    expect(find("%")).toEqual(["100%_pure"]);
    expect(find("_")).toEqual(["100%_pure", "x_y"]);
    expect(find("\\")).toEqual(["a\\b"]);
    expect(find("0%_")).toEqual(["100%_pure"]);
  });

  it("folds ASCII case like PG ILIKE (locale C) and matches Arabic exactly", () => {
    expect(find("ahmad")).toEqual(["AHMAD trade", "Ahmad"]);
    expect(find("أحمد")).toEqual(["أحمد للأقمشة"]);
    expect(find("محم")).toEqual(["محمد"]);
    // locale C: non-ASCII letters do not fold — É and é are different
    expect(find("éclair")).toEqual(["éclair"]);
  });
});
