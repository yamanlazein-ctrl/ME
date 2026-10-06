/**
 * T030/T053 (specs/001-desktop-sqlite-engine): the container wires exactly one engine.
 *   - DB_ENGINE=postgres → the Postgres* repositories (cloud wiring, unchanged);
 *   - DB_ENGINE=sqlite   → the Sqlite* twins, and NO member is a PostgreSQL implementation
 *     (no silent fallback to a PostgreSQL pool).
 * Runs in both suites: `npm test` checks the first, `npm run test:sqlite` the second.
 */
import { describe, it, expect } from "vitest";
import { buildContainer } from "@/infrastructure/di/container.js";
import { getEngine } from "@/infrastructure/orm/engine.js";

describe("container engine selection", () => {
  const engine = getEngine();
  const c = buildContainer() as unknown as Record<string, unknown>;
  const classNames = Object.entries(c)
    .filter(([, v]) => v && typeof v === "object")
    .map(([k, v]) => [k, (v as object).constructor?.name ?? ""] as const);

  it("wires the active engine's repositories", () => {
    const prefix = engine === "sqlite" ? "Sqlite" : "Postgres";
    expect((c.partyRepo as object).constructor.name).toBe(`${prefix}PartyRepository`);
    expect((c.searchRepo as object).constructor.name).toBe(`${prefix}SearchRepository`);
    expect((c.invoiceRepo as object).constructor.name).toBe(`${prefix}InvoiceRepository`);
  });

  it("never mixes engines (no PostgreSQL member on SQLite, no SQLite member on PostgreSQL)", () => {
    const foreign = engine === "sqlite" ? /^Postgres/ : /^Sqlite/;
    expect(classNames.filter(([, n]) => foreign.test(n))).toEqual([]);
  });

  it("keeps the members that never touch the database", () => {
    for (const k of ["jwtSigner", "passwordHasher", "fingerprintProvider"]) expect(c[k]).toBeTruthy();
  });
});
