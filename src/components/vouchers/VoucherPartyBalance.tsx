import { PageCard } from "@/components/layout/PageCard";
import { Button } from "@/components/ui/button";
import { usePartyBalance } from "@/presentation/hooks/useParties";
import { CURRENCIES, formatAmount, type Currency } from "@/presentation/hooks/useCurrency";
import { round2dp } from "@erp/shared";
import type { VoucherKind, VoucherMethod } from "@/domain/types";

/** Ledger balances include openings, returns and on-account vouchers, not just unpaid invoices. */
export function VoucherPartyBalance({
  partyId,
  kind,
  currency,
  onCurrencyChange,
  settlementAmount,
  cashAmount,
  cashBalance,
  method,
  previewOnAccount,
}: {
  partyId: string;
  kind: VoucherKind;
  currency: Currency;
  onCurrencyChange: (currency: Currency) => void;
  settlementAmount: number;
  cashAmount: number;
  cashBalance?: number;
  method: VoucherMethod;
  previewOnAccount: boolean;
}) {
  if (!partyId) return null;
  const cashDelta = kind === "receipt" ? cashAmount : -cashAmount;
  return (
    <PageCard
      title="رصيد الطرف الحالي"
      description="الرصيد من كشف الحساب: يشمل الرصيد الافتتاحي والفواتير والمرتجعات وجميع السندات."
    >
      <div className="grid gap-3 sm:grid-cols-3">
        {CURRENCIES.map((item) => (
          <BalanceRow
            key={`${partyId}:${item.code}`}
            partyId={partyId}
            kind={kind}
            currency={item.code}
            selected={currency === item.code}
            onSelect={() => onCurrencyChange(item.code)}
            settlementAmount={settlementAmount}
            previewOnAccount={previewOnAccount}
          />
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        كل عملة حساب مستقل. لتسديد الرصيد الافتتاحي اختر عملته واترك «دفعة على الحساب»؛ لا يلزم
        إنشاء فاتورة قديمة. الدفعة بعملة أخرى لا تخفض هذا الرصيد تلقائياً، حتى مع إدخال سعر صرف.
      </p>
      {previewOnAccount && cashAmount > 0 && (
        <div
          className="mt-3 rounded-md bg-secondary/40 p-3 text-sm"
          data-testid="voucher-cash-impact"
        >
          {method === "cash" ? (
            <>
              <p>
                أثر السند على الصندوق: {cashDelta > 0 ? "+" : "−"}{" "}
                {formatAmount(Math.abs(cashDelta), currency)}
              </p>
              {cashBalance !== undefined && (
                <p>
                  رصيد الصندوق بعد السند (تقديري):{" "}
                  {formatAmount(round2dp(cashBalance + cashDelta), currency)}
                </p>
              )}
              <p className="mt-1 text-xs text-muted-foreground">
                المسامحة تخفض الذمة فقط ولا تدخل الصندوق ولا تخرج منه.
              </p>
            </>
          ) : (
            <p>التحويل البنكي / الشيك يسدد ذمة الطرف دون تغيير رصيد الصندوق النقدي.</p>
          )}
        </div>
      )}
    </PageCard>
  );
}

/** Exported for the voucher form: shows the selected party's balance beside the party field. */
export function SelectedPartyBalanceBadge(props: {
  partyId: string;
  kind: VoucherKind;
  currency: Currency;
  settlementAmount: number;
  previewOnAccount: boolean;
}) {
  return <SelectedBalanceHeadline {...props} />;
}

/**
 * The first thing the cashier reads: the SELECTED currency's balance, large, with its direction.
 * Always renders a visible state (loading, error with retry, or the amount), never nothing.
 */
function SelectedBalanceHeadline({
  partyId,
  kind,
  currency,
  settlementAmount,
  previewOnAccount,
}: {
  partyId: string;
  kind: VoucherKind;
  currency: Currency;
  settlementAmount: number;
  previewOnAccount: boolean;
}) {
  const balance = usePartyBalance(partyId, currency, { staleTime: 0 });
  const amount = balance.data?.amount;
  const side = (value: number) =>
    value === 0
      ? "متوازن"
      : (kind === "receipt" ? value > 0 : value < 0)
        ? "لنا (مدين)"
        : "علينا (دائن)";
  const projected = amount === undefined ? undefined : round2dp(amount - settlementAmount);

  if (balance.isError) {
    return (
      <div
        role="alert"
        className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
        data-testid="party-balance-headline"
      >
        <span>تعذّر تحميل رصيد الطرف — لا يُعتبر الرصيد صفراً.</span>
        <Button type="button" size="sm" variant="outline" onClick={() => void balance.refetch()}>
          إعادة المحاولة
        </Button>
      </div>
    );
  }
  if (amount === undefined) {
    return (
      <div
        role="status"
        className="mb-3 rounded-lg border border-border bg-secondary/40 p-3 text-sm text-muted-foreground"
        data-testid="party-balance-headline"
      >
        جاري تحميل رصيد الطرف…
      </div>
    );
  }
  return (
    <div
      className="mb-3 rounded-lg border border-primary/40 bg-primary/5 p-4"
      data-testid="party-balance-headline"
    >
      <p className="text-xs text-muted-foreground">الرصيد الحالي ({currency})</p>
      <p
        className="mt-1 text-2xl font-bold tabular-nums"
        data-testid="party-balance-headline-amount"
      >
        {formatAmount(Math.abs(amount), currency)}{" "}
        <span className="text-base font-semibold">{side(amount)}</span>
      </p>
      {previewOnAccount && settlementAmount > 0 && projected !== undefined && (
        <p className="mt-2 text-sm" data-testid="party-balance-headline-after">
          بعد هذا السند (تقديري): {formatAmount(Math.abs(projected), currency)} {side(projected)}
        </p>
      )}
    </div>
  );
}

function BalanceRow({
  partyId,
  kind,
  currency,
  selected,
  onSelect,
  settlementAmount,
  previewOnAccount,
}: {
  partyId: string;
  kind: VoucherKind;
  currency: Currency;
  selected: boolean;
  onSelect: () => void;
  settlementAmount: number;
  previewOnAccount: boolean;
}) {
  const balance = usePartyBalance(partyId, currency, { staleTime: 0 });
  const amount = balance.data?.amount;
  const direction = (value: number) =>
    value === 0
      ? "متوازن"
      : (kind === "receipt" ? value > 0 : value < 0)
        ? "لنا (مدين)"
        : "علينا (دائن)";
  const projected = amount === undefined ? undefined : round2dp(amount - settlementAmount);

  return (
    <div
      className={`rounded-lg border p-3 ${selected ? "border-primary/50 bg-primary/5" : "border-border"}`}
      data-testid={`party-balance-${currency}`}
      aria-busy={balance.isFetching}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-semibold">{currency}</span>
        {selected ? (
          <span className="text-xs text-muted-foreground">عملة السند</span>
        ) : (
          <Button type="button" size="sm" variant="outline" onClick={onSelect}>
            استخدم {currency} للسند
          </Button>
        )}
      </div>
      {balance.isError ? (
        <div role="alert">
          <p>تعذّر تحميل الرصيد — لا يُعتبر الرصيد صفراً.</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void balance.refetch()}>
            إعادة المحاولة
          </Button>
        </div>
      ) : amount === undefined ? (
        <p role="status">جاري تحميل الرصيد…</p>
      ) : (
        <>
          <p className="text-sm font-semibold" data-testid={`party-current-${currency}`}>
            الرصيد الحالي: {formatAmount(Math.abs(amount), currency)} {direction(amount)}
          </p>
          {balance.isFetching ? (
            <p role="status" className="text-xs text-muted-foreground">
              جاري تحديث الرصيد…
            </p>
          ) : selected && previewOnAccount && settlementAmount > 0 && projected !== undefined ? (
            <p className="mt-2 text-sm" data-testid={`party-after-${currency}`}>
              الرصيد بعد السند (تقديري): {formatAmount(Math.abs(projected), currency)}{" "}
              {direction(projected)}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
