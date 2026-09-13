import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  lastJournalIdx,
  resolveMigrationsFolder,
  shouldBaselineExistingCluster,
} from "../src/infrastructure/orm/runDesktopMigrations.js";

const BACKEND = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = path.join(BACKEND, "src", "infrastructure", "orm", "migrations");

describe("desktop boot migrator helpers", () => {
  it("baselines only when schema exists without drizzle history", () => {
    expect(shouldBaselineExistingCluster(true, 0)).toBe(true);
    expect(shouldBaselineExistingCluster(true, 3)).toBe(false);
    expect(shouldBaselineExistingCluster(false, 0)).toBe(false);
  });

  it("resolves the repo migrations folder", () => {
    expect(resolveMigrationsFolder(undefined, BACKEND)).toBe(MIGRATIONS);
    expect(resolveMigrationsFolder(MIGRATIONS, "/does-not-exist")).toBe(MIGRATIONS);
  });

  it("reads the last journal idx from disk", () => {
    const idx = lastJournalIdx(MIGRATIONS);
    expect(idx).toBeGreaterThanOrEqual(63);
  });
});
