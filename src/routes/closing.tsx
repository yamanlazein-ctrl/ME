import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  beginCounting,
  closeYear,
  getClosingPreview,
  getCountSheet,
  postVariance,
  recordCount,
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
  // Local edits keyed by rollId, so a re-render never drops what was typed.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

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

  const startCounting = useMutation({
    mutationFn: () => beginCounting(year),
    onSuccess: () => {
      toast.success(`بدأ جرد سنة ${year}.`);
      refreshAll();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "تعذّر بدء الجرد."),
  });

  const saveCount = useMutation({
    mutationFn: (v: { rollId: string; countedKg: number | null }) =>
      recordCount({ year, rollId: v.rollId, countedKg: v.countedKg }),
    onSuccess: (_r, v) => {
      setDrafts((d) => {
        const next = { ...d };
        delete next[v.rollId];
        return next;
      });
      refreshAll();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "تعذّر حفظ الجرد."),
  });

  const post = useMutation({
    mutationFn: (countId: string) => postVariance(countId),
    onSuccess: (r) => {
      toast.success(
        r.movementId
          ? `تم ترحيل ${r.diffKg > 0 ? "زيادة" : "عجز"} ${Math.abs(r.diffKg)} كغ كحركة رسمية.`
          : "لا يوجد فرق — تمت التسوية دون حركة.",
      );
      refreshAll();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "تعذّر ترحيل التسوية."),
  });

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
      title="إقفال السنة المالية والجرد"
      subtitle="جرد فعلي للمخزون، ترحيل الفروقات كحركات رسمية، ثم إقفال السنة — دون حذف أي مستند سابق."
      actions={
        <div className="flex items-center gap-2">
          <Input
            type="number"
            value={year}
            onChange={(e) => setYear(Number(e.target.value) || now)}
            className="h-8 w-24"
            aria-label="السنة"
          />
          <Button
            variant="outline"
            size="sm"
            disabled={isClosed || startCounting.isPending}
            onClick={() => startCounting.mutate()}
          >
            بدء الجرد
          </Button>
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

      <CountSheet
        year={year}
        disabled={isClosed}
        drafts={drafts}
        setDrafts={setDrafts}
        onSave={(rollId, countedKg) => saveCount.mutate({ rollId, countedKg })}
        onPost={(countId) => post.mutate(countId)}
        saving={saveCount.isPending}
        posting={post.isPending}
      />

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

/**
 * The count sheet. Book vs physical vs difference, per roll.
 *
 * `drafts` holds unsaved keystrokes so a background refetch cannot wipe what
 * the counter typed. "ترحيل" is only offered once the physical figure is SAVED
 * (a count row with an id exists) and actually differs from the book figure —
 * posting needs a real `countId` to write the movement against.
 */
function CountSheet({
  year,
  disabled,
  drafts,
  setDrafts,
  onSave,
  onPost,
  saving,
  posting,
}: {
  year: number;
  disabled: boolean;
  drafts: Record<string, string>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onSave: (rollId: string, countedKg: number | null) => void;
  onPost: (countId: string) => void;
  saving: boolean;
  posting: boolean;
}) {
  const sheet = useQuery({
    queryKey: ["count-sheet", year],
    queryFn: () => getCountSheet(year),
    // One page only — the server keyset-paginates, so the WebView never holds
    // every roll of a tenant that has thousands.
    staleTime: 0,
  });

  return (
    <div className="rounded-xl border border-border bg-card shadow-soft" dir="rtl">
      <h3 className="border-b border-border p-3 font-semibold">
        ورقة الجرد الفعلي {sheet.data ? `(${sheet.data.total} لفة)` : ""}
      </h3>
      {sheet.isPending && (
        <p className="p-4 text-center text-sm text-muted-foreground">جارٍ التحميل…</p>
      )}
      {sheet.isError && (
        <p className="p-4 text-center text-sm text-destructive">تعذّر تحميل ورقة الجرد.</p>
      )}
      {sheet.data && sheet.data.lines.length === 0 && (
        <p className="p-4 text-center text-sm text-muted-foreground">لا توجد لفافات.</p>
      )}
      {sheet.data && sheet.data.lines.length > 0 && (
        <div className="max-h-[50vh] overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>القماش</TableHead>
                <TableHead>اللون</TableHead>
                <TableHead>اللفة</TableHead>
                <TableHead>الدفتري</TableHead>
                <TableHead>الفعلي</TableHead>
                <TableHead>الفرق</TableHead>
                <TableHead>إجراء</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sheet.data.lines.map((l) => {
                const draft = drafts[l.rollId];
                const raw = draft !== undefined ? Number(draft) : l.countedKg;
                const effective = raw == null || Number.isNaN(raw) ? null : raw;
                const diff =
                  effective == null ? null : Math.round((effective - l.bookKg) * 100) / 100;
                return (
                  <TableRow key={l.rollId}>
                    <TableCell>{l.fabricName}</TableCell>
                    <TableCell>{l.colorName}</TableCell>
                    <TableCell className="tabular-nums">#{l.rollNo}</TableCell>
                    <TableCell className="tabular-nums">{formatNumber(l.bookKg)}</TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        step="0.01"
                        className="h-8 w-24"
                        value={draft ?? (l.countedKg ?? "")}
                        disabled={disabled}
                        onChange={(e) =>
                          setDrafts((d) => ({ ...d, [l.rollId]: e.target.value }))
                        }
                      />
                    </TableCell>
                    <TableCell
                      className={`tabular-nums font-semibold ${
                        diff == null || diff === 0
                          ? ""
                          : diff > 0
                            ? "text-emerald-600"
                            : "text-destructive"
                      }`}
                    >
                      {diff == null ? "—" : `${diff > 0 ? "+" : ""}${formatNumber(diff)}`}
                    </TableCell>
                    <TableCell>
                      {l.status === "posted" ? (
                        <span className="text-xs text-muted-foreground">مرحّلة</span>
                      ) : (
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={disabled || saving}
                            onClick={() => onSave(l.rollId, effective)}
                          >
                            حفظ
                          </Button>
                          <Button

                            size="sm"
                            variant="destructive"
                            disabled={disabled || posting || !l.countId || diff == null || diff === 0}
                            title={l.countId ? "????? ????? ?????" : "???? ????? ?????? ?????"}
                            onClick={() => l.countId && onPost(l.countId)}
                          >
                            ?????
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
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

