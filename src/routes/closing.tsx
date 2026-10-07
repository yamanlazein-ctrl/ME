import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { formatNumber } from "@/shared/utils/formatNumber";
import {
  closeYear,
  getClosingPreview,
  reopenYear,
  type YearStatus,
} from "@/infrastructure/api/YearClosingApi";

export const Route = createFileRoute("/closing")({ component: YearClosingPage });

const STATUS_LABEL: Record<YearStatus, string> = {
  open: "مفتوحة",
  counting: "قيد الجرد",
  ready: "جاهزة للإقفال",
  closed: "مقفلة",
};

const STATUS_CLASS: Record<YearStatus, string> = {
  open: "bg-primary/10 text-primary",
  counting: "bg-amber-500/15 text-amber-700",
  ready: "bg-sky-500/15 text-sky-700",
  closed: "bg-destructive/10 text-destructive",
};

const money = (n: number, currency: string) =>
  `${formatNumber(n)} ${currency === "SYP" ? "ل.س" : currency === "USD" ? "$" : currency}`;

/** Renders each currency on its own — SYP and USD are never merged into one. */
function formatCurrencyMap(map: Record<string, number> | undefined): string {
  if (!map) return "—";
  const entries = Object.entries(map);
  if (!entries.length) return "—";
  return entries.map(([c, v]) => money(v, c)).join(" · ");
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-secondary/30 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

function YearClosingPage() {
  const qc = useQueryClient();
  const now = new Date().getFullYear();
  const [year, setYear] = useState(now);
  const [typed, setTyped] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const preview = useQuery({
    queryKey: ["closing-preview", year],
    queryFn: () => getClosingPreview(year),
    staleTime: 0,
  });

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ["closing-preview"] });
    void qc.invalidateQueries({ queryKey: ["count-sheet"] });
    void qc.invalidateQueries({ queryKey: ["inventory"] });
  };

  const close = useMutation({
    mutationFn: () => closeYear(year),
    onSuccess: (r) => {
      toast.success(
        `أُقفلت سنة ${r.year}. رصيد الصندوق الختامي محفوظ، وتاريخ ${r.year} كامل للرجوع إليه.`,
      );
      setConfirmOpen(false);
      setTyped("");
      refreshAll();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "تعذّر الإقفال."),
  });

  const reopen = useMutation({
    mutationFn: () => reopenYear(year, reopenReason),
    onSuccess: () => {
      toast.success(`أُعيد فتح سنة ${year}، وتم تسجيل العملية في سجل النشاط.`);
      setReopenOpen(false);
      setReopenReason("");
      refreshAll();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "تعذّرت إعادة الفتح."),
  });

  const p = preview.data;
  const isClosed = p?.status === "closed";
  const blockers = p?.blockers ?? [];
  const canClose = Boolean(p) && !isClosed && blockers.length === 0 && typed === "إقفال";

  return (
    <AppShell
      title="إقفال السنة المالية"
      subtitle="تجميد سنة كاملة ضد التعديل وحفظ أرصدتها الختامية — دون حذف أي مستند سابق. الجرد الفعلي له صفحته الخاصة."
      actions={
        <div className="flex items-center gap-2">
          <Input
            type="number"
            value={year}
            onChange={(e) => setYear(Number(e.target.value) || now)}
            className="h-8 w-24"
            aria-label="السنة"
          />
          {isClosed ? (
            <Button variant="outline" size="sm" onClick={() => setReopenOpen(true)}>
              إعادة الفتح
            </Button>
          ) : (
            <Button
              variant="destructive"
              size="sm"
              disabled={!canClose}
              onClick={() => setConfirmOpen(true)}
            >
              إقفال السنة
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-4" dir="rtl">
        <div className="rounded-xl border border-border bg-card p-4 shadow-soft">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-semibold">
              سنة {year} — {p?.periodStart} إلى {p?.periodEnd}
            </h2>
            <span
              className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
                STATUS_CLASS[p?.status ?? "open"]
              }`}
            >
              {STATUS_LABEL[p?.status ?? "open"]}
            </span>
          </div>

          {preview.isPending && (
            <p className="py-4 text-center text-sm text-muted-foreground">جارٍ الحساب…</p>
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="إجمالي اللفافات"
              value={formatNumber(p?.counts.rolls ?? 0)}
              hint={`عدّ ${p?.counts.counted ?? 0} · متبقٍ ${p?.counts.pending ?? 0}`}
            />
            <Stat
              label="الرصيد الدفتري (قيمة المخزون)"
              value={formatCurrencyMap(p?.closingInventoryValue)}
            />
            <Stat
              label="رصيد الصندوق الختامي"
              value={formatCurrencyMap(p?.closingCashbox)}
              hint="لكل عملة على حدة"
            />
            <Stat
              label="فروقات الجرد"
              value={`زيادة ${formatNumber(p?.counts.gainsKg ?? 0)} / عجز ${formatNumber(p?.counts.lossesKg ?? 0)} كغ`}
              hint={`${p?.counts.withVariance ?? 0} سطر · مرحّل ${p?.counts.posted ?? 0}`}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card p-4">
          <div className="me-auto text-sm">
            <p className="font-semibold">الجرد الفعلي (قبل الإقفال)</p>
            <p className="text-muted-foreground">
              عُدّ {formatNumber(p?.counts.counted ?? 0)} من {formatNumber(p?.counts.rolls ?? 0)} صبغة · فروقات غير مرحّلة:{" "}
              {formatNumber(Math.max(0, (p?.counts.withVariance ?? 0) - (p?.counts.posted ?? 0)))}
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/inventory/count">فتح الجرد الفعلي</Link>
          </Button>
        </div>

        <div
          className={`rounded-xl border p-4 ${
            blockers.length ? "border-destructive/50 bg-destructive/5" : "border-border bg-card"
          }`}
        >
          <h3 className="mb-2 font-semibold">قائمة التحقق قبل الإقفال</h3>
          {blockers.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              لا توجد عوائق — الجرد مكتمل ولا توجد فروقات غير مرحّلة.
            </p>
          ) : (
            <ul className="list-inside list-disc space-y-1 text-sm text-destructive">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
          {p && !isClosed && (
            <div className="mt-3 flex items-center gap-2">
              <label htmlFor="close-confirm" className="text-sm font-semibold">
                للتأكيد اكتب: <code className="rounded bg-muted px-1">إقفال</code>
              </label>
              <Input
                id="close-confirm"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                className="h-8 w-40"
                autoComplete="off"
              />
            </div>
          )}
        </div>
      </div>

      <CloseDialogs
        year={year}
        confirmOpen={confirmOpen}
        setConfirmOpen={setConfirmOpen}
        closing={close.isPending}
        onClose={() => close.mutate()}
        reopenOpen={reopenOpen}
        setReopenOpen={setReopenOpen}
        reopenReason={reopenReason}
        setReopenReason={setReopenReason}
        reopening={reopen.isPending}
        onReopen={() => reopen.mutate()}
      />
    </AppShell>
  );
}

function CloseDialogs({
  year,
  confirmOpen,
  setConfirmOpen,
  closing,
  onClose,
  reopenOpen,
  setReopenOpen,
  reopenReason,
  setReopenReason,
  reopening,
  onReopen,
}: {
  year: number;
  confirmOpen: boolean;
  setConfirmOpen: (v: boolean) => void;
  closing: boolean;
  onClose: () => void;
  reopenOpen: boolean;
  setReopenOpen: (v: boolean) => void;
  reopenReason: string;
  setReopenReason: (v: string) => void;
  reopening: boolean;
  onReopen: () => void;
}) {
  return (
    <>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent dir="rtl">
          <DialogHeader>
            <DialogTitle className="text-destructive">تأكيد إقفال السنة {year}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p>سيُقفل سجل السنة {year} ضد التعديل، ويُحفظ رصيد الصندوق الختامي لكل عملة.</p>
            <p className="text-muted-foreground">
              لن يُحذف أي مستند: فواتير {year} وسندات وحركات المخزون تبقى كاملة وقابلة للطباعة
              والمراجعة، ويبدأ العام الجديد بنفس الأرصدة.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              إلغاء
            </Button>
            <Button variant="destructive" disabled={closing} onClick={onClose}>
              {closing ? "جارٍ الإقفال…" : "نعم، أقفل السنة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={reopenOpen} onOpenChange={setReopenOpen}>
        <DialogContent dir="rtl">
          <DialogHeader>
            <DialogTitle>إعادة فتح السنة {year}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p>
              إعادة الفتح عملية إدارية حساسة تُسجَّل في سجل النشاط باسمك وبالوقت. لن يُحذف أي
              تاريخ.
            </p>
            <Input
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
              placeholder="سبب إعادة الفتح (إلزامي)"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReopenOpen(false)}>
              إلغاء
            </Button>
            <Button
              variant="destructive"
              disabled={reopenReason.trim().length < 5 || reopening}
              onClick={onReopen}
            >
              إعادة الفتح
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

