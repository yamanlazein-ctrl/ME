import { useMemo, useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { canWriteOffline } from "../../../../src/core/roles";
import { useRole } from "../../../../src/hooks/useRole";
import { usePartyProfile, usePartyStatement } from "../../../../src/hooks/useParties";
import { SharePdfButton } from "../../../../src/ui/SendToCustomer";
import {
  DATE_RE,
  periodRange,
  StatementView,
  type PeriodPreset,
} from "../../../../src/ui/PartyViews";
import { LoadingState, Notice, Screen } from "../../../../src/ui/kit";

export default function StatementScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const role = useRole();
  const profile = usePartyProfile(id);
  const [currency, setCurrency] = useState("ALL");
  const [period, setPeriod] = useState<PeriodPreset>("all");
  const [dates, setDates] = useState({ from: "", to: "" });
  const party = profile.data;
  const range = useMemo(() => {
    if (period !== "custom") return periodRange(period, new Date());
    return {
      from: DATE_RE.test(dates.from) ? dates.from : null,
      to: DATE_RE.test(dates.to) ? dates.to : null,
    };
  }, [period, dates]);
  const statement = usePartyStatement(
    party ? { partyId: id, kind: party.kind, currency, from: range.from, to: range.to } : null,
  );
  if (!party)
    return (
      <Screen title="كشف الحساب">
        <LoadingState />
      </Screen>
    );
  const currencies = party.balances.map((b) => b.currency);
  // A PDF is one currency: the chosen one, or the only one the party uses.
  const pdfCurrency =
    currency !== "ALL" ? currency : currencies.length === 1 ? currencies[0] : null;
  return (
    <StatementView
      partyName={party.name}
      kind={party.kind}
      currencies={currencies}
      currency={currency}
      period={period}
      from={dates.from}
      to={dates.to}
      data={statement.data}
      loading={statement.isLoading}
      error={statement.error}
      share={
        pdfCurrency ? (
          <SharePdfButton
            docRef={{
              type: "statement",
              partyId: id,
              kind: party.kind,
              currency: pdfCurrency,
              from: range.from,
              to: range.to,
            }}
            label="مشاركة الكشف PDF"
          />
        ) : (
          <Notice kind="info" text="لمشاركة الكشف PDF اختر عملة واحدة أولاً." />
        )
      }
      onCurrency={setCurrency}
      onPeriod={setPeriod}
      onDates={(patch) => setDates((d) => ({ ...d, ...patch }))}
      onRetry={() => void statement.refetch()}
      onOpenEntry={(e) => {
        if (!e.referenceId) return;
        if (e.type === "sales_invoice" || e.type === "purchase_invoice") {
          router.push(`/invoices/${e.referenceId}` as never);
        } else if ((e.type === "receipt_in" || e.type === "payment_out") && canWriteOffline(role)) {
          router.push({
            pathname: e.type === "receipt_in" ? "/(tabs)/add/receipt" : "/(tabs)/add/payment",
            params: { amendId: e.referenceId },
          } as never);
        }
      }}
    />
  );
}
