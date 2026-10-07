import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/layout/AppShell";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { container } from "@/infrastructure/container";
import { formatNumber } from "@/shared/utils/formatNumber";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RollAdjustDialog } from "@/components/inventory/InventoryDialogs";
import { colorById, fabricById, rollById, rolls, useInventory, type Roll } from "@/presentation/hooks/useInventory";

export const Route = createFileRoute("/inventory_/adjustments")({ component: InventoryAdjustmentsPage });

type Snap = { rollNo?: string; remainingKg?: number; remainingPieces?: number; deltaKg?: number; deltaPieces?: number; reference?: string; syncedFrom?: string };

const signed = (n: number | undefined) => (n == null ? "—" : `${n > 0 ? "+" : ""}${formatNumber(n)}`);

/**
 * «تعديلات المخزون»: every quantity / pieces change made outside a document —
 * manual adjustments and posted inventory counts, from this device or synced
 * from others. Who, when, before, after, difference, why.
 */
function InventoryAdjustmentsPage() {
  const q = useQuery({
    queryKey: ["inventory", "adjustments"],
    queryFn: () => container.audit.api.listByModule("inventory_adjustments"),
  });
  const all = q.data ?? [];
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<"all" | "count" | "manual">("all");
  const [picking, setPicking] = useState(false);
  const [target, setTarget] = useState<Roll | null>(null);
  const term = search.trim().toLowerCase();
  const rows = all.filter((r) => {
    if (kind === "count" && r.action !== "post_count_variance") return false;
    if (kind === "manual" && r.action === "post_count_variance") return false;
    if (!term) return true;
    const a = (r.afterSnapshot ?? {}) as Snap;
    return [a.rollNo, r.actorName, r.detail].some((v) => String(v ?? "").toLowerCase().includes(term));
  });
  return (
    <AppShell>
      <div className="rounded-xl border border-border bg-card shadow-soft" dir="rtl">
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <h2 className="me-auto font-semibold">تعديلات المخزون</h2>
          <Input
            className="h-8 w-56"
            placeholder="بحث: رقم الصبغة، المستخدم، السبب"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className="h-8 rounded-md border border-border bg-background px-2 text-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="all">الكل</option>
            <option value="manual">تعديل يدوي</option>
            <option value="count">تسوية جرد</option>
          </select>
          <Button size="sm" onClick={() => setPicking(true)}>
            تعديل جديد
          </Button>
        </div>
        {q.isPending && <p className="p-4 text-center text-sm text-muted-foreground">جارٍ التحميل…</p>}
        {q.isError && <p className="p-4 text-center text-sm text-destructive">تعذّر تحميل تعديلات المخزون.</p>}
        {!q.isPending && !q.isError && rows.length === 0 && (
          <p className="p-4 text-center text-sm text-muted-foreground">لا توجد تعديلات بعد.</p>
        )}
        {rows.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>التاريخ</TableHead>
                <TableHead>المستخدم</TableHead>
                <TableHead>اللفة</TableHead>
                <TableHead>النوع</TableHead>
                <TableHead>الكمية قبل → بعد (كغ)</TableHead>
                <TableHead>الفرق (كغ)</TableHead>
                <TableHead>الأثواب قبل → بعد</TableHead>
                <TableHead>فرق الأثواب</TableHead>
                <TableHead>السبب</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const b = (r.beforeSnapshot ?? {}) as Snap;
                const a = (r.afterSnapshot ?? {}) as Snap;
                return (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap">
                      {new Date(r.createdAt).toLocaleString("ar", { dateStyle: "short", timeStyle: "short" })}
                    </TableCell>
                    <TableCell>
                      {r.actorName ?? "—"}
                      {a.syncedFrom && <span className="ms-1 text-[11px] text-muted-foreground">(من جهاز آخر)</span>}
                    </TableCell>
                    <TableCell className="tabular-nums">#{a.rollNo ?? b.rollNo ?? "—"}</TableCell>
                    <TableCell>{r.action === "post_count_variance" ? "تسوية جرد" : "تعديل يدوي"}</TableCell>
                    <TableCell className="tabular-nums">
                      {formatNumber(b.remainingKg ?? 0)} → {formatNumber(a.remainingKg ?? 0)}
                    </TableCell>
                    <TableCell
                      className={`tabular-nums font-semibold ${(a.deltaKg ?? 0) < 0 ? "text-destructive" : (a.deltaKg ?? 0) > 0 ? "text-emerald-600" : ""}`}
                    >
                      {signed(a.deltaKg)}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {b.remainingPieces ?? 0} → {a.remainingPieces ?? 0}
                    </TableCell>
                    <TableCell className="tabular-nums">{signed(a.deltaPieces)}</TableCell>
                    <TableCell>{r.detail ?? "—"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
      <RollPicker
        open={picking}
        onClose={() => setPicking(false)}
        onPick={(r) => {
          setPicking(false);
          setTarget(r);
        }}
      />
      <RollAdjustDialog
        roll={target ? (rollById(target.id) ?? target) : null}
        onClose={() => {
          setTarget(null);
          void q.refetch();
        }}
      />
    </AppShell>
  );
}

/** Find the roll to adjust by roll number, fabric or colour. */
function RollPicker({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (r: Roll) => void }) {
  const invVersion = useInventory();
  const [term, setTerm] = useState("");
  const matches = useMemo(() => {
    const t = term.trim().toLowerCase();
    const label = (r: Roll) => {
      const c = colorById(r.colorId);
      return `${r.rollNo} ${c?.name ?? ""} ${c?.code ?? ""} ${fabricById(c?.fabricId ?? "")?.name ?? ""} ${r.dyeBatch ?? ""}`.toLowerCase();
    };
    return (t ? rolls.filter((r) => label(r).includes(t)) : rolls).slice(0, 30);
  }, [term, invVersion]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir="rtl" className="max-w-lg">
        <DialogHeader>
          <DialogTitle>اختر الصبغة</DialogTitle>
        </DialogHeader>
        <Input autoFocus placeholder="رقم الصبغة، القماش، اللون…" value={term} onChange={(e) => setTerm(e.target.value)} />
        <ul className="max-h-[50vh] divide-y divide-border overflow-y-auto text-sm">
          {matches.map((r) => {
            const c = colorById(r.colorId);
            return (
              <li key={r.id}>
                <button type="button" className="flex w-full justify-between gap-2 px-2 py-2 text-start hover:bg-secondary" onClick={() => onPick(r)}>
                  <span>
                    #{r.rollNo} — {fabricById(c?.fabricId ?? "")?.name ?? "—"} / {c?.name ?? "—"}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {formatNumber(Number(r.remainingKg ?? 0))} كغ · {r.remainingPieces ?? 0} ثوب
                  </span>
                </button>
              </li>
            );
          })}
          {matches.length === 0 && <li className="p-3 text-center text-muted-foreground">لا نتائج.</li>}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
