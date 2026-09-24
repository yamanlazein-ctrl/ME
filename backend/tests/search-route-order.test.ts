/**
 * "/parties/search" and "/parties/by-ids" live on the same router as
 * "/parties/:id" (validateUuidParam → 400). Express matches in registration
 * order, so the search routes must be registered first — otherwise the
 * customer picker's typeahead always fails with "id must be a UUID".
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("search routes are registered before entity :id routes", () => {
  it("registerSearchRoutes precedes registerPartyRoutes in server.ts", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/presentation/server.ts"), "utf8");
    const search = src.indexOf("registerSearchRoutes(");
    const party = src.indexOf("registerPartyRoutes(");
    expect(search).toBeGreaterThan(-1);
    expect(party).toBeGreaterThan(-1);
    expect(search).toBeLessThan(party);
  });
});
