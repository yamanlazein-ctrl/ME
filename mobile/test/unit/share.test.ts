import { describe, expect, it } from "vitest";
import { SHARE_OPENED, SHARE_UNAVAILABLE, sharePdf, type ShareDeps } from "../../src/core/share";
import { pdfFileName } from "../../src/print/pdfName";

function deps(over: Partial<ShareDeps> = {}): ShareDeps & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    isAvailable: async () => true,
    open: async (uri, title) => void opened.push(`${title}|${uri}`),
    ...over,
  };
}

describe("PDF sharing (FR-29, FR-30)", () => {
  it("opens the share sheet with the document's title and never claims delivery", async () => {
    const d = deps();
    const r = await sharePdf("file:///cache/Invoice-INV-000012.pdf", "فاتورة INV-000012", d);
    expect(r).toEqual({ ok: true, message: SHARE_OPENED });
    expect(r.message).not.toMatch(/أُرسل|تم الإرسال/);
    expect(d.opened).toEqual(["فاتورة INV-000012|file:///cache/Invoice-INV-000012.pdf"]);
  });

  it("says so when no app can receive files, and when the sheet fails", async () => {
    expect(await sharePdf("u", "t", deps({ isAvailable: async () => false }))).toEqual({
      ok: false,
      message: SHARE_UNAVAILABLE,
    });
    const failing = deps({
      open: async () => {
        throw new Error("Activity not found");
      },
    });
    expect((await sharePdf("u", "t", failing)).ok).toBe(false);
  });

  it("names the file after the document in ASCII", () => {
    expect(pdfFileName("Invoice", "INV-000012")).toBe("Invoice-INV-000012.pdf");
    expect(pdfFileName("Statement", "2026-03-01")).toBe("Statement-2026-03-01.pdf");
    expect(pdfFileName("Receipt", "سند/12")).toBe("Receipt-12.pdf");
    expect(pdfFileName("", "")).toBe("Document.pdf");
  });
});
