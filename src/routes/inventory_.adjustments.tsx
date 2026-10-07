import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/layout/AppShell";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { container } from "@/infrastructure/container";
import { formatNumber } from "@/shared/utils/formatNumber";

export const Route = createFileRoute("/inventory_/adjustments")({ component: InventoryAdjustmentsPage });

type Snap = { rollNo?: string; remainingKg?: number; remainingPieces?: number; deltaKg?: number; deltaPieces?: number; reference?: string };

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
  const rows = q.data ?? [];
  return (
    <AppShell>
      <div className="rounded-xl border border-border bg-card shadow-soft" dir="rtl">
        <h2 className="border-b border-border p-3 font-semibold">تعديلات المخزون</h2>
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
                    <TableCell>{r.actorName ?? "—"}</TableCell>
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
    </AppShell>
  );
}
