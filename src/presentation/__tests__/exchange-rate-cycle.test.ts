import { describe, it, expect, vi, beforeEach } from "vitest";

/* ── Mock the settings API (via the DI container) and sonner toasts ──
 * The exchange-rate cycle lives in the presentation layer:
 *   settings page → updateCurrencyRate → setExchangeRate (live state) + PUT /api/settings/currencies
 *   app boot      → loadSettings → GET /api/settings → applies persisted rates (survives reload)
 * The dashboard $ amounts read currencyState.rates.USD, so updating that
 * state IS the live dashboard update. */

const getSettingsMock = vi.hoisted(() => vi.fn());
const updateSectionMock = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/infrastructure/container", () => ({
  container: {
    settings: {
      api: {
        getSettings: () => getSettingsMock(),
        updateSection: (section: string, value: unknown) => updateSectionMock(section, value),
      },
    },
  },
}));

import { EXCHANGE_RATES } from "@/presentation/hooks/useCurrency";

const today = new Date().toISOString().slice(0, 10);

/** Fresh module instances → reset defaults and the loadStarted guard (simulates a page reload). */
async function freshModules() {
  vi.resetModules();
  const cur = await import("@/presentation/hooks/useCurrency");
  const set = await import("@/presentation/hooks/useSettings");
  return { ...cur, ...set };
}

describe("exchange-rate change cycle", () => {
  beforeEach(() => {
    getSettingsMock.mockReset();
    updateSectionMock.mockReset();
    getSettingsMock.mockResolvedValue({});
    updateSectionMock.mockResolvedValue({});
  });

  it("setExchangeRate updates the live rate and date immediately (what the dashboard reads)", async () => {
    const { currencyState: st, setExchangeRate } = await freshModules();
    expect(st.rates.USD).toBe(EXCHANGE_RATES.USD); // default before any change
    setExchangeRate("USD", 18000);
    expect(st.rates.USD).toBe(18000);
    expect(st.lastUpdated).toBe(today);
  });

  it("updateCurrencyRate applies the rate live AND persists it through the settings API", async () => {
    const { currencyState: st, updateCurrencyRate } = await freshModules();
    updateCurrencyRate("USD", 19000);
    // live state updated immediately
    expect(st.rates.USD).toBe(19000);
    // persisted to the backend settings section
    expect(updateSectionMock).toHaveBeenCalledWith(
      "currencies",
      expect.arrayContaining([{ code: "USD", rate: 19000 }]),
    );
  });

  it("loadSettings applies persisted rates after a reload, falling back to defaults for missing currencies", async () => {
    getSettingsMock.mockResolvedValue({
      currencies: [
        { code: "SYP", rate: 1 },
        { code: "USD", rate: 20000 },
      ],
    });
    const { currencyState: st, loadSettings } = await freshModules();
    expect(st.rates.USD).toBe(EXCHANGE_RATES.USD); // fresh page → defaults
    await loadSettings();
    expect(st.rates.USD).toBe(20000); // persisted rate restored after reload
    expect(st.rates.EUR).toBe(EXCHANGE_RATES.EUR); // not stored in settings → default fallback
    expect(getSettingsMock).toHaveBeenCalledTimes(1);
  });
});
