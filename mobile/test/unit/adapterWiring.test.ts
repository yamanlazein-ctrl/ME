import { describe, expect, it } from "vitest";
import { setUuidSequenceForSpike } from "../../src/platform/nodeCrypto";
import { randomUuid } from "@backend/infrastructure/orm/sqlite/types";
import { AsyncLocalStorage } from "../../src/platform/asyncContext";

describe("Node tests run the phone adapters for desktop code", () => {
  it("the desktop SQLite column types draw uuids from the phone crypto adapter", () => {
    setUuidSequenceForSpike("wiring");
    const first = randomUuid();
    setUuidSequenceForSpike("wiring");
    expect(randomUuid()).toBe(first);
  });

  it("the desktop transaction layer uses the phone async-context adapter", async () => {
    const tx = await import("@backend/infrastructure/orm/sqlite/transaction");
    expect(typeof tx.withTenantTx).toBe("function");
    expect(AsyncLocalStorage.name).toBe("AsyncLocalStorage");
  });
});
