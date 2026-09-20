import { AppShell } from "@/components/layout/AppShell";
import { PageCard } from "@/components/layout/PageCard";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormField } from "@/components/common/FormField";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useCashboxState,
  useCashBalance,
  useManualMovements,
  useAddManualMovement,
  useDeleteManualMovement,
  useSetOpeningBalance,
  useCloseDay as useCloseDayMutation,
  MANUAL_TYPE_LABEL,
  type ManualMovementType,
} from "@/presentation/hooks/useCashbox";
import { useLedgerEntries, useCashMovementsOn } from "@/presentation/hooks/useLedger";
import { formatAmount } from "@/presentation/hooks/useCurrency";
import { Lock, Plus, RotateCw, Settings2 } from "lucide-react";
import { FinancialSummary } from "@/components/cashbox/FinancialSummary";
import { PeriodFilterCard, type CashboxPeriodFilter } from "@/components/cashbox/PeriodFilterCard";
import { FinancialOverview } from "@/components/cashbox/FinancialOverview";
import { ActivityTabs } from "@/components/cashbox/ActivityTabs";
import type { ProfitQueryParams } from "@/contracts/profit";

export const Route = createFileRoute("/cashbox")({
  validateSearch: (search: Record<string, unknown>): CashboxPeriodFilter & { tab?: string } => ({
    from: typeof search.from === "string" ? search.from : "",
    to: typeof search.to === "string" ? search.to : "",
    currency: typeof search.currency === "string" ? search.currency : "all",
    tab: typeof search.tab === "string" ? search.tab : undefined,
  }),
  component: CashBoxPage,
});

/**
 * CASHBOX — Financial Control Center.
 *
 * Information architecture (visual priority):
 *   A. Header actions (refresh / manual movement / close day)
 *   B. Financial Summary — tiered (balance hero → in/out/net/count)
 *   C. Filter Toolbar (single source for every period-scoped section)
 *   D. Financial Overview (profitability + debts, collapsible details)
 *   E. Quick Actions strip
 *   F. Activity Tabs (one visible table: movements/invoices/receipts/payments)
 *   G. Secondary settings (bottom)
 *
 * All state (from/to/currency/tab) lives in URL search params so navigating
 * to an invoice and returning preserves the exact view.
 */
function CashBoxPage() {
  const today = new Date().toISOString().slice(0, 10);
  const qc = useQueryClient();
  const { data: state, dataUpdatedAt } = useCashboxState();
  const openingToday = state?.openingBalance ?? 0;
  const last = state?.lastClosing ?? null;
  const locked = state?.isLocked ?? false;
  const { data: balSYP = 0 } = useCashBalance(today, "SYP");
  const { data: balUSD } = useCashBalance(today, "USD");
  const { data: balEUR } = useCashBalance(today, "EUR");
  const { data: todayFlowSYP } = useCashMovementsOn(today, "SYP");
  const { data: todayFlowUSD } = useCashMovementsOn(today, "USD");
  const { data: todayFlowEUR } = useCashMovementsOn(today, "EUR");
  const { data: manualMoves = [] } = useManualMovements();
  const addMovement = useAddManualMovement();
  const deleteMovement = useDeleteManualMovement();
  const setOpening = useSetOpeningBalance();
  const closeDayMut = useCloseDayMutation();

  const [manOpen, setManOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [openingEdit, setOpeningEdit] = useState(false);
  const [tabOverride, setTabOverride] = useState<string | null>(null);

  const cs = state ?? {
    openingBalance: 0,
    currency: "SYP" as const,
    openingDate: "",
    isLocked: false,
    lastClosing: null,
  };

  // ── URL-persisted period + tab state ──
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    .toISOString()
    .slice(0, 10);
  const period: CashboxPeriodFilter = {
    from: search.from || monthStart,
    to: search.to || today,
    currency: search.currency || "all",
  };
  const activeTab = tabOverride ?? search.tab ?? "transactions";
  // Optimistic local override so the tab responds INSTANTLY on click; the URL
  // remains the persisted source of truth once navigation settles.
  const patchSearch = (patch: Partial<CashboxPeriodFilter & { tab?: string }>) =>
    navigate({ search: (prev) => ({ ...prev, ...patch }) });
  const changeTab = (t: string) => {
    setTabOverride(t);
    patchSearch({ tab: t });
  };

  // Same values feed every period-scoped section — display == API request.
  const profitQuery: ProfitQueryParams = {
    fromDate: period.from,
    toDate: period.to,
    ...(period.currency !== "all" ? { currency: period.currency } : {}),
  };

  const refreshAll = () => {
    for (const key of ["cashbox", "ledger", "profit", "invoices", "vouchers", "dashboard"]) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  };

  const perCurrency: Record<string, number> = {
    SYP: balSYP,
    USD: balUSD ?? 0,
    EUR: balEUR ?? 0,
  };
  // Independent per-currency flows — never converted or summed across boxes.
  const todayFlowByCurrency: Record<string, { in: number; out: number }> = {
    SYP: todayFlowSYP ?? { in: 0, out: 0 },
    USD: todayFlowUSD ?? { in: 0, out: 0 },
    EUR: todayFlowEUR ?? { in: 0, out: 0 },
  };
  // Day-close uses the session currency box only (opening applies there).
  const sessionCurrency = cs.currency || "SYP";
  const todayIn = todayFlowByCurrency[sessionCurrency]?.in ?? 0;
  const todayOut = todayFlowByCurrency[sessionCurrency]?.out ?? 0;

  // Today's transaction count (light query; separate cache entry from the tab feed).
  const { data: todayLedgerResult } = useLedgerEntries({
    fromDate: today,
    toDate: today,
    limit: 500,
  });
  const txCount =
    (todayLedgerResult ?? []).filter((e) => e.status === "active" && e.cashImpact !== "none")
      .length + manualMoves.filter((m) => m.date === today).length;

  return (
    <AppShell
      title="الصندوق"
      subtitle="حركة النقدية وإدارة السيولة"
      actions={
        <div className="flex items-center gap-2">
          {/* Secondary */}
          <Button variant="outline" size="sm" onClick={refreshAll} title="تحديث كل البيانات">
            <RotateCw className="h-4 w-4 ml-1" /> تحديث
          </Button>
          {/* Primary */}
          <Button variant="outline" size="sm" onClick={() => setManOpen(true)} disabled={locked}>
            <Plus className="h-4 w-4 ml-1" /> حركة يدوية
          </Button>
          <Button size="sm" onClick={() => setCloseOpen(true)} disabled={locked}>
            <Lock className="h-4 w-4 ml-1" /> إقفال اليوم
          </Button>
        </div>
      }
    >
      {locked && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive flex items-center gap-2">
          <Lock className="h-4 w-4" /> اليوم مقفل — لا يمكن تسجيل حركات جديدة بتاريخ اليوم.
        </div>
      )}

      {/* B — Financial Summary: independent SYP / USD boxes (no FX mix) */}
      <FinancialSummary
        todayFlowByCurrency={todayFlowByCurrency}
        txCount={txCount}
        openingBalance={cs.openingBalance}
        openingCurrency={cs.currency}
        openingDate={cs.openingDate}
        perCurrency={perCurrency}
        lastUpdatedAt={dataUpdatedAt}
      />

      {/* C — Filter Toolbar */}
      <PeriodFilterCard value={period} onChange={patchSearch} />

      {/* D — Financial Overview (profitability ≠ cash position) */}
      <FinancialOverview query={profitQuery} />

      {/* E — Quick Actions (calm zone: ghost buttons, one row) */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-border bg-card/60 px-4 py-2.5">
        <span className="ml-1 text-xs text-muted-foreground">إجراءات سريعة:</span>
        <Button asChild size="sm" variant="ghost" className="h-8">
          <Link to="/receipts/new">سند قبض</Link>
        </Button>
        <Button asChild size="sm" variant="ghost" className="h-8">
          <Link to="/payments/new">سند صرف</Link>
        </Button>
        <Button asChild size="sm" variant="ghost" className="h-8">
          <Link to="/expenses/new">مصروف جديد</Link>
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8"
          onClick={() => setManOpen(true)}
          disabled={locked}
        >
          حركة يدوية
        </Button>
      </div>

      {/* F — Main Activity Tabs */}
      <ActivityTabs
        query={profitQuery}
        period={period}
        tab={activeTab}
        onTabChange={changeTab}
        manualMoves={manualMoves}
        onDeleteManual={(id) => deleteMovement.mutate(id)}
      />

      {/* G — Secondary settings */}
      <PageCard
        title="إعدادات الصندوق"
        description="الرصيد الافتتاحي وآخر إقفال."
        actions={
          <Button type="button" variant="outline" size="sm" onClick={() => setOpeningEdit(true)}>
            <Settings2 className="h-4 w-4 ml-1" /> تعديل الرصيد الافتتاحي
          </Button>
        }
      >
        <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <div className="text-muted-foreground">
            الرصيد الافتتاحي منذ {cs.openingDate || "—"}:{" "}
            <span className="font-bold text-foreground tabular-nums" dir="ltr">
              {formatAmount(cs.openingBalance, cs.currency)}
            </span>
          </div>
          <div className="text-muted-foreground">
            آخر إقفال:{" "}
            <span className="font-bold text-foreground">{last ? last.date : "لم يتم"}</span>
          </div>
          <div className="text-muted-foreground">
            عملة الجلسة: <span className="font-bold text-foreground">{cs.currency}</span>
          </div>
        </div>
      </PageCard>

      <OpeningDialog open={openingEdit} onClose={() => setOpeningEdit(false)} />
      <ManualDialog open={manOpen} onClose={() => setManOpen(false)} />
      <ClosingDialog
        open={closeOpen}
        onClose={() => setCloseOpen(false)}
        opening={openingToday}
        inn={todayIn}
        out={todayOut}
      />
    </AppShell>
  );
}

/* ── Dialogs — same logic as before the restructure (unchanged behavior) ── */

function OpeningDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: state } = useCashboxState();
  const cs = state ?? {
    openingBalance: 0,
    currency: "SYP" as const,
    openingDate: "",
  };
  const [v, setV] = useState(cs.openingBalance);
  const [currency, setCurrency] = useState<"SYP" | "USD">(cs.currency === "USD" ? "USD" : "SYP");
  const [balErr, setBalErr] = useState<string | null>(null);
  const setOpening = useSetOpeningBalance();
  const today = new Date().toISOString().slice(0, 10);
  const save = () => {
    if (!v || Number(v) <= 0) {
      setBalErr("أدخل رصيداً صحيحاً أكبر من صفر.");
      return;
    }
    setOpening.mutate({ balance: v, date: today, currency });
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>تعديل الرصيد الافتتاحي للصندوق</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <div>
            <Label>عملة الصندوق</Label>
            <Select value={currency} onValueChange={(v) => setCurrency(v as "SYP" | "USD")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="SYP">ليرة سورية (SYP)</SelectItem>
                <SelectItem value="USD">دولار (USD)</SelectItem>
              </SelectContent>
            </Select>
            <p className="mt-1 text-[11px] text-muted-foreground">
              الافتتاحي يخص عملة واحدة فقط — لا يُحوَّل ولا يُخلط مع الصندوق الآخر.
            </p>
          </div>
          <FormField label="المبلغ" error={balErr ?? undefined}>
            <Input
              type="number"
              value={v}
              onChange={(e) => {
                setV(Number(e.target.value));
                setBalErr(null);
              }}
            />
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
          <Button onClick={save}>حفظ</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ManualDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: state } = useCashboxState();
  const cs = state ?? {
    openingBalance: 0,
    currency: "SYP" as const,
    openingDate: "",
  };
  const [type, setType] = useState<ManualMovementType>("adjustment");
  const [dir, setDir] = useState<"in" | "out">("in");
  const [amount, setAmount] = useState<number | "">("");
  const [currency, setCurrency] = useState<"SYP" | "USD">(cs.currency === "USD" ? "USD" : "SYP");
  const [desc, setDesc] = useState("");
  const [amtErr, setAmtErr] = useState<string | null>(null);
  const [descErr, setDescErr] = useState<string | null>(null);
  const addMovement = useAddManualMovement();
  const save = () => {
    let valid = true;
    if (!amount || Number(amount) <= 0) {
      setAmtErr("أدخل مبلغاً صحيحاً أكبر من صفر.");
      valid = false;
    }
    if (!desc.trim()) {
      setDescErr("الوصف مطلوب.");
      valid = false;
    }
    if (!valid) return;
    addMovement.mutate(
      {
        date: new Date().toISOString().slice(0, 10),
        type,
        direction: dir,
        amount: Number(amount),
        currency,
        description: desc,
      },
      {
        onSuccess: () => {
          setAmount("");
          setDesc("");
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>حركة يدوية جديدة</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div>
            <Label>النوع</Label>
            <Select value={type} onValueChange={(v) => setType(v as ManualMovementType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(MANUAL_TYPE_LABEL).map(([k, l]) => (
                  <SelectItem key={k} value={k}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>الاتجاه</Label>
            <Select value={dir} onValueChange={(v) => setDir(v as "in" | "out")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="in">وارد</SelectItem>
                <SelectItem value="out">صادر</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>العملة (صندوق مستقل)</Label>
            <Select value={currency} onValueChange={(v) => setCurrency(v as "SYP" | "USD")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="SYP">ليرة سورية (SYP)</SelectItem>
                <SelectItem value="USD">دولار (USD)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <FormField label="المبلغ" error={amtErr ?? undefined}>
            <Input
              type="number"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value === "" ? "" : Number(e.target.value));
                setAmtErr(null);
              }}
            />
          </FormField>
          <FormField label="الوصف" error={descErr ?? undefined}>
            <Input
              value={desc}
              onChange={(e) => {
                setDesc(e.target.value);
                setDescErr(null);
              }}
            />
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
          <Button onClick={save}>حفظ</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ClosingDialog({
  open,
  onClose,
  opening,
  inn,
  out,
}: {
  open: boolean;
  onClose: () => void;
  opening: number;
  inn: number;
  out: number;
}) {
  const { data: state } = useCashboxState();
  const cs = state ?? {
    openingBalance: 0,
    currency: "SYP" as const,
    openingDate: "",
  };
  const expected = opening + inn - out;
  const [counted, setCounted] = useState<number | "">("");
  const diff = (Number(counted) || 0) - expected;
  const closeDayMut = useCloseDayMutation();
  const save = () => {
    if (counted === "") return;
    closeDayMut.mutate(
      {
        date: new Date().toISOString().slice(0, 10),
        openingBalance: opening,
        totalIn: inn,
        totalOut: out,
        counted: Number(counted),
        currency: cs.currency,
      },
      { onSuccess: () => onClose() },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>الإقفال اليومي</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 text-sm">
          <Row label="الرصيد الافتتاحي" value={formatAmount(opening, cs.currency)} />
          <Row label="مجموع الوارد" value={formatAmount(inn, cs.currency)} />
          <Row label="مجموع الصادر" value={formatAmount(out, cs.currency)} />
          <Row label="الرصيد المتوقع" value={formatAmount(expected, cs.currency)} bold />
          <div>
            <Label>المبلغ الفعلي المعدود</Label>
            <Input
              type="number"
              value={counted}
              onChange={(e) => setCounted(e.target.value === "" ? "" : Number(e.target.value))}
            />
          </div>
          <div
            className={`rounded p-2 font-bold ${diff === 0 ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}
          >
            الفرق: {formatAmount(diff, cs.currency)}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
          <Button onClick={save}>تأكيد الإقفال</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "font-bold" : ""}`}>
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
