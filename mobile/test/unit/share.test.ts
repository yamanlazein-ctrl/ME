import { describe, expect, it, vi } from "vitest";
import { sendToCustomer, whatsappDigits, type ShareDeps } from "../../src/core/share";
import { renderReturnHtml, renderVoucherHtml } from "../../src/print/renderHtml";

function deps(over: Partial<ShareDeps> = {}): ShareDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    sharePdf: vi.fn(async () => void calls.push("share")),
    openWhatsApp: vi.fn(async () => void calls.push("intent")),
    openUrl: vi.fn(async () => void calls.push("url")),
    contentUri: vi.fn(async (u: string) => `content://${u}`),
    ...over,
  };
}

describe("whatsappDigits", () => {
  it("normalises local, 00 and + numbers and refuses junk", () => {
    expect(whatsappDigits("0933 123 456")).toBe("963933123456");
    expect(whatsappDigits("+963 933-123-456")).toBe("963933123456");
    expect(whatsappDigits("00963933123456")).toBe("963933123456");
    expect(whatsappDigits("123")).toBeNull();
    expect(whatsappDigits("")).toBeNull();
    expect(whatsappDigits(null)).toBeNull();
  });
});

describe("sendToCustomer fallback order", () => {
  const args = { phone: "0933123456", note: "فاتورة INV-1", pdfUri: "file:///a.pdf" };

  it("uses the WhatsApp intent with the jid and the PDF stream, and nothing else", async () => {
    const d = deps();
    const r = await sendToCustomer(args, d);
    expect(r).toEqual({ route: "whatsapp", tried: ["whatsapp"] });
    expect(d.calls).toEqual(["intent"]);
    expect(d.openWhatsApp).toHaveBeenCalledWith({
      jid: "963933123456@s.whatsapp.net",
      note: "فاتورة INV-1",
      contentUri: "content://file:///a.pdf",
    });
  });

  it("when WhatsApp is missing, opens the wa.me link and then the share sheet", async () => {
    const d = deps({ openWhatsApp: vi.fn(async () => Promise.reject(new Error("no app"))) });
    const r = await sendToCustomer(args, d);
    expect(r).toEqual({ route: "share", tried: ["wa.me", "share"] });
    expect(d.calls).toEqual(["url", "share"]);
    expect(d.openUrl).toHaveBeenCalledWith(
      `https://wa.me/963933123456?text=${encodeURIComponent("فاتورة INV-1")}`,
    );
  });

  it("when the link cannot open either, the share sheet still opens", async () => {
    const d = deps({
      openWhatsApp: vi.fn(async () => Promise.reject(new Error("no app"))),
      openUrl: vi.fn(async () => Promise.reject(new Error("no browser"))),
    });
    const r = await sendToCustomer(args, d);
    expect(r).toEqual({ route: "share", tried: ["share"] });
    expect(d.calls).toEqual(["share"]);
  });

  it("refuses a number that is not usable before touching anything", async () => {
    const d = deps();
    await expect(sendToCustomer({ ...args, phone: "12" }, d)).rejects.toThrow(
      "رقم الهاتف غير صالح",
    );
    expect(d.calls).toEqual([]);
  });
});

describe("voucher and return pages", () => {
  it("print the number, the party, the amounts and the cancelled mark", () => {
    const v = renderVoucherHtml({
      kind: "receipt",
      number: "VOC-2026-0001",
      date: "2026-03-01",
      partyName: "عميل <b>",
      amount: 100,
      discount: 10,
      currency: "USD",
      method: "cash",
      cancelled: false,
    });
    expect(v).toContain("سند قبض");
    expect(v).toContain("VOC-2026-0001");
    expect(v).toContain("&lt;b&gt;");
    expect(v).toContain("90.00");
    const r = renderReturnHtml({
      kind: "sale",
      number: "RET-2026-0001",
      date: "2026-03-01",
      partyName: "عميل",
      currency: "SYP",
      cancelled: true,
      lines: [{ label: "R1", quantityKg: 2, pricePerKg: 40000 }],
    });
    expect(r).toContain("مرتجع بيع");
    expect(r).toContain("ملغى");
    expect(r).toContain("80000.00");
  });
});
