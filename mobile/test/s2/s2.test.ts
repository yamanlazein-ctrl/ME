import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeRuntime, openRuntime } from "../../src/core/runtime";
import { buildPhoneRepositories } from "../../src/core/container";
import { runS2 } from "../../src/core/spikeS2";
import { openNodeShim } from "../helpers/nodeSqlite";
import { compareFiles } from "../../scripts/compare-db.mjs";

const REFERENCE = path.resolve(__dirname, "../../../specs/002-mobile-app/evidence/s2-reference.db");
const dirs: string[] = [];

async function produce(file: string) {
  const conn = openNodeShim(file);
  const runtime = openRuntime(conn);
  const result = await runS2(conn, buildPhoneRepositories());
  conn.pragma("wal_checkpoint(TRUNCATE)");
  closeRuntime(runtime);
  return result;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("S2 deterministic routine", () => {
  it("two runs on fresh databases produce identical rows (0 differences)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "motard-s2-"));
    dirs.push(dir);
    const a = await produce(path.join(dir, "a.db"));
    const b = await produce(path.join(dir, "b.db"));
    expect(a).toEqual(b);
    expect(compareFiles(path.join(dir, "a.db"), path.join(dir, "b.db"))).toEqual([]);
    // 10×61,625 + 7.5×61,625 + 2.25×72,500 = 616,250 + 462,187.5 + 163,125 (each line rounded to 2 dp)
    expect(a.invoiceTotal).toBeCloseTo(1241562.5, 2);
  });

  it("matches the committed reference database that the owner compares the phone against (T086 step 8)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "motard-s2-"));
    dirs.push(dir);
    await produce(path.join(dir, "fresh.db"));
    expect(compareFiles(path.join(dir, "fresh.db"), REFERENCE)).toEqual([]);
  });

  it.skipIf(!process.env.S2_OUT)(
    "writes the reference database (scripts/s2-reference.mjs)",
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "motard-s2-"));
      dirs.push(dir);
      await produce(path.join(dir, "ref.db"));
      mkdirSync(path.dirname(process.env.S2_OUT as string), { recursive: true });
      copyFileSync(path.join(dir, "ref.db"), process.env.S2_OUT as string);
    },
  );
});
