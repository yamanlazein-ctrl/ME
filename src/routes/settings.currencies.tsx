import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageCard } from "@/components/layout/PageCard";
import {
  useCurrencies,
  CURRENCIES,
  currencyState,
  setDefaultCurrency,
  type Currency,
} from "@/presentation/hooks/useCurrency";
import { updateCurrencyRate } from "@/presentation/hooks/useSettings";

export const Route = createFileRoute("/settings/currencies")({ component: CurrenciesPage });

function CurrenciesPage() {
  useCurrencies();
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(CURRENCIES.map((c) => [c.code, String(currencyState.rates[c.code])])),
  );
  const [saved, setSaved] = useState(false);

  const save = () => {
    let changed = false;
    for (const c of CURRENCIES) {
      const v = Number(drafts[c.code]);
      if (Number.isFinite(v) && v > 0 && v !== currencyState.rates[c.code]) {
        updateCurrencyRate(c.code, v);
        changed = true;
      }
    }
    if (changed) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    }
  };

  return (
    <PageCard
      title="العملات"
      description={`العملة الافتراضية: ${currencyState.defaultCurrency} — آخر تحديث لأسعار الصرف: ${currencyState.lastUpdated}`}
      noBodyPadding
    >
      <table className="w-full text-right text-sm">
        <thead className="bg-secondary/60 text-[11px] uppercase text-muted-foreground">
          <tr className="[&>th]:px-3 [&>th]:py-2.5">
            <th>الرمز</th>
            <th>الاسم</th>
            <th>الرمز المختصر</th>
            <th className="text-left">سعر الصرف (مقابل SYP)</th>
            <th>افتراضية</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {CURRENCIES.map((c) => (
            <tr key={c.code}>
              <td className="px-3 py-2 font-mono">{c.code}</td>
              <td className="px-3 py-2">{c.label}</td>
              <td className="px-3 py-2">{c.symbol}</td>
              <td className="px-3 py-2 text-left">
                <input
                  type="number"
                  min={0}
                  step="any"
                  dir="ltr"
                  className="h-8 w-36 rounded-md border border-input bg-background px-2 text-left tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={drafts[c.code] ?? ""}
                  onChange={(e) => {
                    setDrafts((d) => ({ ...d, [c.code]: e.target.value }));
                    setSaved(false);
                  }}
                />
              </td>
              <td className="px-3 py-2">
                <input
                  type="radio"
                  name="default"
                  checked={currencyState.defaultCurrency === c.code}
                  onChange={() => setDefaultCurrency(c.code as Currency)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center justify-end gap-3 border-t px-4 py-3">
        {saved && <span className="text-sm text-emerald-600">تم حفظ أسعار الصرف</span>}
        <button
          onClick={save}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          حفظ أسعار الصرف
        </button>
      </div>
    </PageCard>
  );
}
