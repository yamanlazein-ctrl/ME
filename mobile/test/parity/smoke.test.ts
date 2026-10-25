import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parityAvailable, startParity, type Parity } from "./harness";

describe.skipIf(!parityAvailable())("parity smoke (T051)", () => {
  let p: Parity;
  beforeAll(async () => {
    p = await startParity(18200);
  }, 900_000);
  afterAll(async () => {
    await p?.stop();
  }, 60_000);

  it("starts hub + desktop + phone, syncs, and compares to 0 differences on empty data", async () => {
    await p.syncAll();
    expect(await p.compareAll()).toEqual([]);
  }, 300_000);
});
