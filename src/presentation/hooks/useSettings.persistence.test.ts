/**
 * CODEBASE_AUDIT_REPORT_hermes F-018, C1-16, C1-17, C1-13 — settings persistence.
 *  F-018: forms may only save after the server's settings are merged (a failed GET stays "not loaded"
 *         and is retried), and the company/printing forms are wired to that.
 *  C1-16: importing a settings file saves each section to the server (it changed memory only).
 *  C1-17: the export carries the server-stored sections only — no users, no passwords, no activity.
 *  C1-13: the admin role label is spelled correctly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const api = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSection: vi.fn(async (_section: string, _value: unknown) => ({})),
}));
vi.mock("@/infrastructure/container", () => ({ container: { settings: { api } } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe("useSettings persistence", () => {
  beforeEach(() => {
    vi.resetModules();
    api.getSettings.mockReset();
    api.updateSection.mockClear();
  });

  it("F-018: not loaded until the GET resolves; a failed GET stays not-loaded and is retried", async () => {
    const mod = await import("./useSettings");
    api.getSettings.mockRejectedValueOnce(new Error("offline"));
    expect(mod.settingsLoaded()).toBe(false);
    await mod.loadSettings();
    expect(mod.settingsLoaded()).toBe(false);
    api.getSettings.mockResolvedValueOnce({ company: { name: "شركة محفوظة" } });
    await mod.loadSettings();
    expect(mod.settingsLoaded()).toBe(true);
    expect(mod.settings.company.name).toBe("شركة محفوظة");
  });

  it("F-018: the company / printing / invoice forms seed from useSettingsDraft and gate save on it", () => {
    for (const f of ["settings.company.tsx", "settings.printing.tsx", "settings.invoice.tsx"]) {
      const src = readFileSync(join(__dirname, "../../routes", f), "utf8");
      expect(src, f).toMatch(/useSettingsDraft\("(company|printing)"\)/);
      expect(src, f).toContain("disabled={!ready}");
      expect(src, f).not.toMatch(/useState\(\{ \.\.\.settings\.(company|printing) \}\)/);
    }
  });

  it("C1-16: an imported file saves every known section to the server", async () => {
    const mod = await import("./useSettings");
    const applied = mod.applyImportedSettings({
      company: { name: "مستوردة" },
      units: [{ id: "u9", name: "متر", symbol: "م", isDefault: true }],
      users: [{ id: "x", password: "secret" }],
      bogus: 1,
    });
    expect(applied.sort()).toEqual(["company", "units"]);
    expect(api.updateSection.mock.calls.map((c) => c[0]).sort()).toEqual(["company", "units"]);
    expect(mod.settings.company.name).toBe("مستوردة");
  });

  it("C1-17: the export has the persisted sections only", async () => {
    const mod = await import("./useSettings");
    const out = mod.exportableSettings();
    expect(Object.keys(out).sort()).toEqual(
      [
        "company",
        "currencies",
        "paymentMethods",
        "printing",
        "taxes",
        "units",
        "warehouses",
      ].sort(),
    );
    expect(JSON.stringify(out)).not.toMatch(/password/i);
  });

  it("C1-13: admin label", async () => {
    expect((await import("./useSettings")).ROLE_LABEL.admin).toBe("مدير النظام");
  });

  it("F-017: print visibility is saved in the replicated printing section, and a printing-form save keeps it", async () => {
    const vis = await import("@/components/print/invoices/visibility");
    const mod = await import("./useSettings");
    vis.setFieldVisibility("sale", "showUnitPrice", false);
    const sent = api.updateSection.mock.calls.at(-1)!;
    expect(sent[0]).toBe("printing");
    expect(
      (sent[1] as { invoiceVisibility: Record<string, Record<string, boolean>> }).invoiceVisibility
        .sale.showUnitPrice,
    ).toBe(false);
    // The printing form's stale copy (seeded before the toggle) must not revert it.
    mod.updatePrinting({ paperSize: "A5", showLogo: true, footerNote: "x", copies: 1 });
    expect(mod.settings.printing.invoiceVisibility?.sale.showUnitPrice).toBe(false);
    expect(vis.getAllVisibility().sale.showUnitPrice).toBe(false);
  });
});
