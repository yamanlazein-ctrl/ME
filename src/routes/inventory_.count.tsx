import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Search } from "lucide-react";
import { toast } from "sonner";
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
import { formatNumber } from "@/shared/utils/formatNumber";
import {
  getCountSheet,
  postVariance,
  recordCount,
  type CountLine,
  type CountSheetFilter,
} from "@/infrastructure/api/YearClosingApi";
import { refreshInventory } from "@/presentation/hooks/useInventory";

export const Route = createFileRoute("/inventory_/count")({ component: PhysicalCountPage });

type Status = NonNullable<CountSheetFilter["status"]>;
const STATUS_CHIPS: Array<[Status | "", string]> = [
  ["", "الكل"],
  ["uncounted", "غير معدود"],
  ["variance", "فيه فرق"],
  ["counted", "معدود"],
  ["posted", "مرحّل"],
];

const r2 = (n: number) => Math.round(n * 100) / 100;
const signed = (n: number) => `${n > 0 ? "+" : ""}${formatNumber(n)}`;
const tone = (n: number | null) =>
  n == null || n === 0 ? "" : n > 0 ? "text-emerald-600" : "text-destructive";
const cur = (c: string) => (c === "SYP" ? "ل.س" : c === "USD" ? "$" : c);
const parse = (v: string) => (v.trim() === "" ? null : Number(v));

/**
 * «الجرد الفعلي» — a physical count, on its own (year closing only reads its result).
 * Type the shelf figure (kg and pieces) and leave the field: it is saved. Differences
 * are against the book AT COUNT TIME, valued at cost, and posted together after review.
 */
function PhysicalCountPage() {
  const qc = useQueryClient();
  const year = new Date().getFullYear();
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<Status | "">("");
  const [since, setSince] = useState("");
  const [includeEmpty, setIncludeEmpty] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setQ(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const filter: CountSheetFilter = {
    q,
    status: status || undefined,
    since: since || undefined,
    includeEmpty,
  };
  const sheet = useInfiniteQuery({
    queryKey: ["count-sheet", year, filter],
    queryFn: ({ pageParam }) => getCountSheet(year, { ...filter, cursor: pageParam, limit: 100 }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 0,
  });
  const progress = useQuery({
    queryKey: ["count-sheet", year, "progress", since, includeEmpty],
    queryFn: async () => {
      const [all, open] = await Promise.all([
        getCountSheet(year, { since: since || undefined, includeEmpty, limit: 1 }),
        getCountSheet(year, {
          since: since || undefined,
          includeEmpty,
          status: "uncounted",
          limit: 1,
        }),
      ]);
      return { total: all.total, counted: all.total - open.total };
    },
    staleTime: 0,
  });
  const lines = useMemo(() => sheet.data?.pages.flatMap((p) => p.lines) ?? [], [sheet.data]);
  const totals = useMemo(() => varianceTotals(lines), [lines]);
  const refresh = () => qc.invalidateQueries({ queryKey: ["count-sheet"] });

  return (
    <AppShell>
      <div
        className="flex h-[calc(100dvh-9rem)] flex-col rounded-xl border border-border bg-card shadow-soft"
        dir="rtl"
      >
        <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-card p-3">
          <h2 className="font-semibold">الجرد الفعلي {year}</h2>
          <span className="rounded-md bg-secondary px-2 py-0.5 text-xs tabular-nums">
            عُدّ {formatNumber(progress.data?.counted ?? 0)} من{" "}
            {formatNumber(progress.data?.total ?? 0)}
          </span>
          <span className="text-xs tabular-nums">
            <span className="text-emerald-600">زيادة {formatNumber(totals.gainKg)} كغ</span> ·{" "}
            <span className="text-destructive">عجز {formatNumber(totals.lossKg)} كغ</span> · أثواب{" "}
            {signed(totals.pieces)}
            <span className="text-muted-foreground"> (الصفوف المعروضة)</span>
          </span>
          <Button size="sm" className="ms-auto" onClick={() => setReviewOpen(true)}>
            مراجعة وترحيل الفروقات
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-sm">
          <div className="relative">
            <Search className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-8 w-64 pr-8"
              placeholder="القماش، اللون، رقم الصبغة أو الدفعة"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {STATUS_CHIPS.map(([s, label]) => (
            <button
              key={label}
              type="button"
              onClick={() => setStatus(s)}
              className={`rounded-full border px-3 py-1 text-xs ${status === s ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}
            >
              {label}
            </button>
          ))}
          <label
            className="ms-auto flex items-center gap-1 text-xs"
            title="جولة جرد جديدة: ما عُدّ قبل هذا التاريخ يظهر غير معدود"
          >
            جولة منذ
            <Input
              type="date"
              className="h-8 w-36"
              value={since}
              onChange={(e) => setSince(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={includeEmpty}
              onChange={(e) => setIncludeEmpty(e.target.checked)}
            />
            إظهار اللفات الفارغة
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {sheet.isPending && (
            <p className="p-4 text-center text-sm text-muted-foreground">جارٍ التحميل…</p>
          )}
          {sheet.isError && (
            <p className="p-4 text-center text-sm text-destructive">تعذّر تحميل ورقة الجرد.</p>
          )}
          {!sheet.isPending && lines.length === 0 && (
            <p className="p-4 text-center text-sm text-muted-foreground">لا توجد صبغات مطابقة.</p>
          )}
          {lines.length > 0 && (
            <Table>
              <TableHeader className="sticky top-0 z-[1] bg-card">
                <TableRow>
                  <TableHead>القماش / اللون</TableHead>
                  <TableHead>الصبغة</TableHead>
                  <TableHead>الدفتري</TableHead>
                  <TableHead>الفعلي (كغ)</TableHead>
                  <TableHead>الفعلي (أثواب)</TableHead>
                  <TableHead>الفرق</TableHead>
                  <TableHead>قيمة الفرق</TableHead>
                  <TableHead>الحالة</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((l) => (
                  <CountRow key={l.rollId} line={l} year={year} onSaved={refresh} />
                ))}
              </TableBody>
            </Table>
          )}
          {sheet.hasNextPage && (
            <div className="p-3 text-center">
              <Button
                variant="outline"
                size="sm"
                disabled={sheet.isFetchingNextPage}
                onClick={() => void sheet.fetchNextPage()}
              >
                {sheet.isFetchingNextPage ? "جارٍ التحميل…" : "تحميل المزيد"}
              </Button>
            </div>
          )}
        </div>
      </div>
      <ReviewDialog
        open={reviewOpen}
        year={year}
        since={since}
        onClose={() => setReviewOpen(false)}
        onPosted={() => {
          void refresh();
          void refreshInventory();
        }}
      />
    </AppShell>
  );
}

function varianceTotals(lines: CountLine[]) {
  const t = { gainKg: 0, lossKg: 0, pieces: 0, value: {} as Record<string, number> };
  for (const l of lines) {
    if (l.status === "posted") continue;
    const d = l.diffKg ?? 0;
    if (d > 0) t.gainKg = r2(t.gainKg + d);
    if (d < 0) t.lossKg = r2(t.lossKg - d);
    t.pieces += l.diffPieces ?? 0;
    t.value[l.currency] = r2((t.value[l.currency] ?? 0) + d * l.pricePerKg);
  }
  return t;
}

/** One roll: type the shelf figures, leave the field (or Enter) and it is saved. */
function CountRow({ line, year, onSaved }: { line: CountLine; year: number; onSaved: () => void }) {
  const [kg, setKg] = useState(line.countedKg == null ? "" : String(line.countedKg));
  const [pieces, setPieces] = useState(
    line.countedPieces == null ? "" : String(line.countedPieces),
  );
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0);
  useEffect(() => {
    setKg(line.countedKg == null ? "" : String(line.countedKg));
    setPieces(line.countedPieces == null ? "" : String(line.countedPieces));
  }, [line.countedKg, line.countedPieces]);

  const kgN = parse(kg);
  const piecesN = parse(pieces);
  const diffKg = kgN == null || Number.isNaN(kgN) ? null : r2(kgN - line.bookKg);
  const diffPieces = piecesN == null || Number.isNaN(piecesN) ? null : piecesN - line.bookPieces;
  const dirty = kgN !== line.countedKg || piecesN !== line.countedPieces;
  const posted = line.status === "posted" && !dirty;

  const save = async () => {
    if (!dirty || saving) return;
    if (
      (kgN != null && (Number.isNaN(kgN) || kgN < 0)) ||
      (piecesN != null && (!Number.isInteger(piecesN) || piecesN < 0))
    ) {
      toast.error("أدخل كمية صحيحة (كغ ≥ 0، أثواب عدد صحيح ≥ 0).");
      return;
    }
    if (kgN == null && piecesN != null) {
      toast.error("أدخل الكيلوغرام الفعلي أيضاً (0 إن كانت فارغة).");
      return;
    }
    setSaving(true);
    try {
      await recordCount({ year, rollId: line.rollId, countedKg: kgN, countedPieces: piecesN });
      setSavedAt(Date.now());
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر حفظ العدّ.");
    } finally {
      setSaving(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
  };

  return (
    <TableRow className={posted ? "opacity-70" : ""}>
      <TableCell>
        <div className="font-medium">{line.fabricName}</div>
        <div className="text-xs text-muted-foreground">{line.colorName}</div>
      </TableCell>
      <TableCell className="tabular-nums">#{line.rollNo}</TableCell>
      <TableCell className="tabular-nums">
        {formatNumber(line.bookKg)} كغ · {line.bookPieces} ث
        {line.movedKg != null || line.movedPieces != null ? (
          <div
            className="text-[11px] text-amber-700"
            title="تحرّك الرصيد بعد العدّ — أعد العدّ قبل الترحيل"
          >
            تحرّك منذ العدّ: {line.movedKg != null ? `${signed(line.movedKg)} كغ` : ""}
            {line.movedPieces != null ? ` ${signed(line.movedPieces)} ث` : ""}
          </div>
        ) : null}
      </TableCell>
      <TableCell>
        <Input
          type="number"
          step="0.01"
          min="0"
          className="h-8 w-24"
          placeholder="غير معدود"
          value={kg}
          onChange={(e) => setKg(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={onKey}
        />
      </TableCell>
      <TableCell>
        <Input
          type="number"
          step="1"
          min="0"
          className="h-8 w-20"
          placeholder="—"
          value={pieces}
          onChange={(e) => setPieces(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={onKey}
        />
      </TableCell>
      <TableCell className="tabular-nums font-semibold">
        {diffKg == null ? (
          "—"
        ) : (
          <span className={tone(diffKg)}>
            {kgN === 0 && line.bookKg > 0 ? "0 (عجز كامل) " : ""}
            {signed(diffKg)} كغ
          </span>
        )}
        {diffPieces != null && diffPieces !== 0 && (
          <span className={`ms-1 ${tone(diffPieces)}`}>{signed(diffPieces)} ث</span>
        )}
      </TableCell>
      <TableCell className={`tabular-nums ${tone(diffKg)}`}>
        {diffKg == null || diffKg === 0
          ? "—"
          : `${signed(r2(diffKg * line.pricePerKg))} ${cur(line.currency)}`}
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs">
        {saving ? (
          "جارٍ الحفظ…"
        ) : dirty ? (
          <span className="text-amber-700">غير محفوظ</span>
        ) : posted ? (
          "مرحّل"
        ) : line.status === "uncounted" ? (
          <span className="text-muted-foreground">غير معدود</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-emerald-700">
            <Check className="h-3.5 w-3.5" />
            {Date.now() - savedAt < 3000 ? "حُفظ" : "معدود"}
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}

/** Every unposted difference, reviewed together and posted in one go (one transaction per line). */
function ReviewDialog({
  open,
  year,
  since,
  onClose,
  onPosted,
}: {
  open: boolean;
  year: number;
  since: string;
  onClose: () => void;
  onPosted: () => void;
}) {
  const [posting, setPosting] = useState(false);
  const review = useQuery({
    queryKey: ["count-sheet", year, "review", since],
    enabled: open,
    staleTime: 0,
    queryFn: async () => {
      const all: CountLine[] = [];
      let cursor: string | null = null;
      do {
        const page = await getCountSheet(year, {
          status: "variance",
          since: since || undefined,
          cursor,
          limit: 500,
          includeEmpty: true,
        });
        all.push(...page.lines);
        cursor = page.nextCursor;
      } while (cursor);
      return all;
    },
  });
  const lines = review.data ?? [];
  const moved = lines.filter((l) => l.movedKg != null || l.movedPieces != null);
  const ready = lines.filter((l) => l.countId && !moved.includes(l));
  const totals = varianceTotals(ready);

  const postAll = async () => {
    setPosting(true);
    const failed: string[] = [];
    for (const l of ready) {
      try {
        await postVariance(l.countId!);
      } catch (e) {
        failed.push(`#${l.rollNo}: ${e instanceof Error ? e.message : "تعذّر الترحيل"}`);
      }
    }
    setPosting(false);
    onPosted();
    if (failed.length)
      toast.error(`لم تُرحَّل ${failed.length}: ${failed.slice(0, 3).join(" · ")}`);
    else toast.success(`تم ترحيل ${ready.length} فرق كحركات تسوية.`);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir="rtl" className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>مراجعة وترحيل فروقات الجرد</DialogTitle>
        </DialogHeader>
        {review.isPending ? (
          <p className="text-sm text-muted-foreground">جارٍ التحميل…</p>
        ) : lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">لا توجد فروقات بانتظار الترحيل.</p>
        ) : (
          <div className="space-y-2 text-sm">
            <p className="tabular-nums">
              {ready.length} فرق جاهز ·{" "}
              <span className="text-emerald-600">زيادة {formatNumber(totals.gainKg)} كغ</span> ·{" "}
              <span className="text-destructive">عجز {formatNumber(totals.lossKg)} كغ</span> · أثواب{" "}
              {signed(totals.pieces)} · القيمة{" "}
              {Object.entries(totals.value)
                .map(([c, v]) => `${signed(v)} ${cur(c)}`)
                .join(" · ") || "—"}
            </p>
            {moved.length > 0 && (
              <p className="text-amber-700">
                {moved.length} صبغة تحرّك رصيدها بعد العدّ ولن تُرحَّل — أعد عدّها أولاً:{" "}
                {moved.map((l) => `#${l.rollNo}`).join("، ")}
              </p>
            )}
            <ul className="max-h-[40vh] divide-y divide-border overflow-y-auto">
              {ready.map((l) => (
                <li key={l.rollId} className="flex justify-between gap-2 py-1.5 tabular-nums">
                  <span>
                    #{l.rollNo} — {l.fabricName} / {l.colorName}
                  </span>
                  <span className={tone(l.diffKg)}>
                    {signed(l.diffKg ?? 0)} كغ{l.diffPieces ? ` · ${signed(l.diffPieces)} ث` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
          <Button disabled={posting || ready.length === 0} onClick={() => void postAll()}>
            {posting ? "جارٍ الترحيل…" : `ترحيل ${ready.length} فرق`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
