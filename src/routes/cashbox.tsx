import { AppShell } from "@/components/layout/AppShell";
import { PageCard } from "@/components/layout/PageCard";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
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
import {
  useLedgerEntries,
  useCashMovementsOn,
  LEDGER_TYPE_LABEL,
} from "@/presentation/hooks/useLedger";
import { formatAmount, CURRENCIES } from "@/presentation/hooks/useCurrency";
import { useHydrated } from "@/hooks/use-hydrated";
import { Lock, Plus, Trash2 } from "lucide-react";

export const Route = createFileRoute("/cashbox")({ component: CashBoxPage });

function CashBoxPage() {
  const hydrated = useHydrated();
  const today = new Date().toISOString().slice(0, 10);

  const { data: state } = useCashboxState();
  const openingToday = state?.openingBalance ?? 0;
  const last = state?.lastClosing ?? null;
  const locked = state?.isLocked ?? false;
  // Server-authoritative KPIs — the paginated ledger feed must NOT be used to
  // derive balances/totals (it only carries the latest N entries).
  const { data: balSYP = 0 } = useCashBalance(today, "SYP");
  const { data: balUSD } = useCashBalance(today, "USD");
  const { data: balEUR } = useCashBalance(today, "EUR");
  const { data: todayFlow } = useCashMovementsOn(today, "SYP");
  const { data: ledgerResult } = useLedgerEntries({ limit: 1000 });
  const ledger = ledgerResult ?? [];
  const { data: manualMoves = [] } = useManualMovements();
  const addMovement = useAddManualMovement();
  const deleteMovement = useDeleteManualMovement();
  const setOpening = useSetOpeningBalance();
  const closeDayMut = useCloseDayMutation();

  const [manOpen, setManOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [openingEdit, setOpeningEdit] = useState(false);

  const cs = state ?? {
    openingBalance: 0,
    currency: "SYP" as const,
    openingDate: "",
    isLocked: false,
    lastClosing: null,
  };

  const currentBalance = balSYP;
  const todayIn = todayFlow?.in ?? 0;
  const todayOut = todayFlow?.out ?? 0;

  const todayLedger = (ledger ?? [])
    .filter(
      (e) =>
        e.status === "active" && e.date === today && e.cashImpact !== "none",
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const manToday = (manualMoves ?? []).filter((m) => m.date === today);
  const rowsCount = todayLedger.length + manToday.length;

  const perCurrency: Record<string, number> = {
    SYP: balSYP,
    USD: balUSD ?? 0,
    EUR: balEUR ?? 0,
  };
  const activeCurrencies = CURRENCIES.filter(
    (c) => perCurrency[c.code] !== undefined,
  );

  const lc = last;

  return (
    <AppShell
      title="الصندوق"
      subtitle="حركة النقدية اليومية والإقفال اليومي — بجميع العملات."
    >
      <div className="grid gap-3 md:grid-cols-6">
        <KpiTile
          label="رصيد أول اليوم"
          value={formatAmount(openingToday, cs.currency)}
        />
        <KpiTile
          label="وارد اليوم"
          value={formatAmount(todayIn, cs.currency)}
          tone="in"
        />
        <KpiTile
          label="صادر اليوم"
          value={formatAmount(todayOut, cs.currency)}
          tone="out"
        />
        <KpiTile
          label="الرصيد الحالي"
          value={formatAmount(currentBalance, cs.currency)}
          tone="primary"
        />
        <KpiTile label="عدد الحركات اليوم" value={String(rowsCount)} />
        <KpiTile label="آخر إقفال" value={lc ? lc.date : "لم يتم"} />
      </div>

      <PageCard
        title="الأرصدة حسب العملة"
        description="مجموع الصندوق موزّع على العملات المستخدمة في النظام."
      >
        <div className="grid gap-3 md:grid-cols-3">
          {activeCurrencies.map((c) => (
            <KpiTile
              key={c.code}
              label={c.label}
              value={formatAmount(perCurrency[c.code] || 0, c.code)}
              tone="primary"
            />
          ))}
        </div>
      </PageCard>

      {locked && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive flex items-center gap-2">
          <Lock className="h-4 w-4" /> يوم اليوم مقفل — لا يمكن تسجيل حركات
          جديدة بتاريخ اليوم.
        </div>
      )}

      <PageCard
        title="إعدادات الصندوق"
        description="الرصيد الافتتاحي للصندوق."
        actions={
          <Button variant="outline" onClick={() => setOpeningEdit(true)}>
            تعديل الرصيد الافتتاحي
          </Button>
        }
      >
        <div className="text-sm text-muted-foreground">
          الرصيد الافتتاحي منذ {cs.openingDate}:{" "}
          <span className="font-bold text-foreground">
            {formatAmount(cs.openingBalance, cs.currency)}
          </span>
        </div>
      </PageCard>

      <PageCard
        title="حركات اليوم"
        description="جميع الحركات النقدية لليوم الحالي."
        actions={
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => setManOpen(true)}
              disabled={locked}
            >
              <Plus className="h-4 w-4 ml-1" /> حركة يدوية
            </Button>
            <Button
              onClick={() => setCloseOpen(true)}
              disabled={locked}
              className="bg-primary text-primary-foreground"
            >
              <Lock className="h-4 w-4 ml-1" /> الإقفال اليومي
            </Button>
          </div>
        }
        noBodyPadding
      >
        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[720px] text-right text-sm">
            <thead className="bg-secondary/60 text-[11px] font-semibold uppercase text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-2.5">
                <th>الوقت</th>
                <th>النوع</th>
                <th>الوصف</th>
                <th>المرجع</th>
                <th className="text-left">وارد</th>
                <th className="text-left">صادر</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {todayLedger.map((e) => (
                <tr key={e.id}>
                  <td className="px-3 py-2 tabular-nums">
                    {hydrated ? e.createdAt.slice(11, 16) : "--:--"}
                  </td>
                  <td className="px-3 py-2">
                    {
                      LEDGER_TYPE_LABEL[
                        e.type as keyof typeof LEDGER_TYPE_LABEL
                      ]
                    }
                  </td>
                  <td className="px-3 py-2">{e.description}</td>
                  <td className="px-3 py-2 text-primary">
                    {e.invoiceId ? (
                      <Link to="/invoices/$id" params={{ id: e.invoiceId }}>
                        {e.referenceNumber}
                      </Link>
                    ) : (
                      e.referenceNumber
                    )}
                  </td>
                  <td className="px-3 py-2 text-left tabular-nums">
                    {e.cashImpact === "in"
                      ? formatAmount(e.debit || e.credit, e.currency)
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-left tabular-nums">
                    {e.cashImpact === "out"
                      ? formatAmount(e.debit || e.credit, e.currency)
                      : "—"}
                  </td>
                  <td></td>
                </tr>
              ))}
              {manToday.map((m) => (
                <tr key={m.id} className="bg-primary/5">
                  <td className="px-3 py-2 tabular-nums">
                    {hydrated ? m.createdAt.slice(11, 16) : "--:--"}
                  </td>
                  <td className="px-3 py-2">
                    {MANUAL_TYPE_LABEL[m.type]}{" "}
                    <span className="text-[10px] rounded bg-primary/20 px-1">
                      يدوية
                    </span>
                  </td>
                  <td className="px-3 py-2">{m.description}</td>
                  <td className="px-3 py-2">—</td>
                  <td className="px-3 py-2 text-left tabular-nums">
                    {m.direction === "in"
                      ? formatAmount(m.amount, m.currency)
                      : "—"}
                  </td>
                  <td className="px-3 py-2 text-left tabular-nums">
                    {m.direction === "out"
                      ? formatAmount(m.amount, m.currency)
                      : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() =>
                        confirm("حذف الحركة؟") && deleteMovement.mutate(m.id)
                      }
                      className="text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
              {rowsCount === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="p-10 text-center text-muted-foreground"
                  >
                    لا حركات اليوم.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
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

function KpiTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "in" | "out" | "primary";
}) {
  const cls =
    tone === "in"
      ? "border-success/40 bg-success/10"
      : tone === "out"
        ? "border-destructive/40 bg-destructive/10"
        : tone === "primary"
          ? "border-primary/40 bg-primary/10"
          : "border-border bg-card";
  return (
    <div className={`rounded-lg border ${cls} p-3`}>
      <div className="text-[11px] font-semibold text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-base font-bold tabular-nums">{value}</div>
    </div>
  );
}

function OpeningDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { data: state } = useCashboxState();
  const cs = state ?? {
    openingBalance: 0,
    currency: "SYP" as const,
    openingDate: "",
  };
  const [v, setV] = useState(cs.openingBalance);
  const [balErr, setBalErr] = useState<string | null>(null);
  const setOpening = useSetOpeningBalance();
  const today = new Date().toISOString().slice(0, 10);
  const save = () => {
    if (!v || Number(v) <= 0) {
      setBalErr("أدخل رصيداً صحيحاً أكبر من صفر.");
      return;
    }
    setOpening.mutate({ balance: v, date: today, currency: cs.currency });
    onClose();
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>تعديل الرصيد الافتتاحي للصندوق</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
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

function ManualDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { data: state } = useCashboxState();
  const cs = state ?? {
    openingBalance: 0,
    currency: "SYP" as const,
    openingDate: "",
  };
  const [type, setType] = useState<ManualMovementType>("adjustment");
  const [dir, setDir] = useState<"in" | "out">("in");
  const [amount, setAmount] = useState<number | "">("");
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
        currency: cs.currency,
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
            <Select
              value={type}
              onValueChange={(v) => setType(v as ManualMovementType)}
            >
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
            <Select
              value={dir}
              onValueChange={(v) => setDir(v as "in" | "out")}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="in">وارد</SelectItem>
                <SelectItem value="out">صادر</SelectItem>
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
          <Row
            label="الرصيد الافتتاحي"
            value={formatAmount(opening, cs.currency)}
          />
          <Row label="مجموع الوارد" value={formatAmount(inn, cs.currency)} />
          <Row label="مجموع الصادر" value={formatAmount(out, cs.currency)} />
          <Row
            label="الرصيد المتوقع"
            value={formatAmount(expected, cs.currency)}
            bold
          />
          <div>
            <Label>المبلغ الفعلي المعدود</Label>
            <Input
              type="number"
              value={counted}
              onChange={(e) =>
                setCounted(e.target.value === "" ? "" : Number(e.target.value))
              }
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

function Row({
  label,
  value,
  bold,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div className={`flex justify-between ${bold ? "font-bold" : ""}`}>
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
