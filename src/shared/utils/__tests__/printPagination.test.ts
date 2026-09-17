import { describe, it, expect } from "vitest";
import { chunkArray, INVOICE_LINES_PER_PRINT_PAGE } from "../printPagination";

describe("printPagination", () => {
  it("splits long invoices into multiple pages", () => {
    const lines = Array.from({ length: 25 }, (_, i) => i);
    const chunks = chunkArray(lines, INVOICE_LINES_PER_PRINT_PAGE);
    expect(chunks.length).toBe(3);
    expect(chunks[0]).toHaveLength(INVOICE_LINES_PER_PRINT_PAGE);
    expect(chunks[2]).toHaveLength(5);
  });
});
