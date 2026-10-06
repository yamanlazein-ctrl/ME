import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { refreshInventory } from "@/presentation/hooks/useInventory";
import { fetchDyeImpact, purgeDye, CONFIRM_WORD, type DyeImpact, type DyePurgeResult } from "./dyePurgeClient";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

/**
 * Corrective cascade delete for a dye (fabric).
 *
 * Nothing is deleted on the first click. The dialog first asks the server what
 * WOULD be removed (`deletion-impact`, read-only), shows the operator every
 * document and every money movement involved, and only then unlocks a typed
 * confirmation. The purge itself is one database transaction, so a partial
 * cascade is not a state the app can end up in.
 */

export type { DyeImpact, DyePurgeResult };

const INVOICE_TYPE_LABEL: Record<string, string> = {
  sale: "فاتورة بيع",
  entry: "فاتورة شراء",
  purchase_invoice: "فاتورة شراء",
  sales_invoice: "فاتورة بيع",
};

function money(n: number, currency: string): string {
  return `${n.toLocaleString("ar-SY", { maximumFractionDigits: 2 })} ${currency}`;
}

export function DyePurgeDialog({
  fabricId,
  fabricName,
  open,
  onOpenChange,
}: {
  fabricId: string | null;
  fabricName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [typed, setTyped] = useState("");

  const impact = useQuery({
    queryKey: ["dye-deletion-impact", fabricId],
    queryFn: () => fetchDyeImpact(fabricId!),
    enabled: open && Boolean(fabricId),
    // A stale impact sheet is how an operator confirms a deletion they did not
    // read. Never serve one from cache.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const purge = useMutation({
    mutationFn: (): Promise<DyePurgeResult> => purgeDye(fabricId!, typed),
    onSuccess: (result) => {
      // Every surface that can now be stale, invalidated together.
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["cashbox"] });
      qc.invalidateQueries({ queryKey: ["parties"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      // The inventory hook also keeps a module-level synchronous cache that
      // React Query cannot see, so it is refreshed explicitly.
      void refreshInventory();
      toast.success(
        `تم حذف «${result.fabricId === fabricId ? (fabricName ?? "الصبغة") : "الصبغة"}» و${result.invoicesDeleted} فاتورة، وتعديل رصيد الصندوق.`,
      );
      setTyped("");
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(
        err instanceof Error ? err.message : "تعذّر إتمام الحذف التصحيحي.",
      );
    },
  });

  const data = impact.data;
  const hasFinancials =
    (data?.affectedInvoices.length ?? 0) > 0 ||
    (data?.rollsCount ?? 0) > 0 ||
    (data?.ledgerEntriesCount ?? 0) > 0;

  const expected = CONFIRM_WORD;
  const confirmationOk = typed.trim() === expected || typed.trim() === (data?.fabricName ?? "");
  const canPurge =
    Boolean(data) && confirmationOk && !purge.isPending && !impact.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setTyped("");
        onOpenChange(next);
      }}
    >
      <DialogContent dir="rtl" className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-destructive">
            تحذير تصحيحي: حذف الصبغة بالكامل وتصفية التبعات
          </DialogTitle>
          <DialogDescription>
            {fabricName ? `الصبغة: ${fabricName}` : "الصبغة"}{" "}
            — سيُحذف ما يلي **نهائياً** ولا يمكن التراجع عنه بعد التأكيد.
          </DialogDescription>
        </DialogHeader>

        {impact.isPending && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            جارٍ فحص التبعات…
          </p>
        )}

        {impact.isError && (
          <p className="py-6 text-center text-sm text-destructive">
            تعذّر فحص التبعات، ولم يُجرَ أي حذف.
          </p>
        )}

        {data && (
          <div className="max-h-[45vh] space-y-4 overflow-y-auto text-sm">
            <ul className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <li>
                سيتم حذف <strong>{data.colorsCount}</strong> لون تابعة و{" "}
                <strong>{data.rollsCount}</strong> لفافة قماش.
              </li>
              <li>
                حركات المخزون المرتبطة: <strong>{data.stockMovementsCount}</strong> · القيود
                المحاسبية: <strong>{data.ledgerEntriesCount}</strong> · سندات القبض/الصرف:{" "}
                <strong>{data.vouchersCount}</strong>
              </li>
            </ul>

            {data.affectedInvoices.length > 0 && (
              <div className="rounded-md border p-3">
                <p className="mb-2 font-semibold">
                  سيتم إلغاء/حذف الفواتير التالية نهائياً ({data.affectedInvoices.length}):
                </p>
                <ul className="list-inside list-disc space-y-0.5 text-muted-foreground">
                  {data.affectedInvoices.map((inv) => (
                    <li key={inv.id}>
                      {INVOICE_TYPE_LABEL[inv.type] ?? "مستند"} #{inv.number} —{" "}
                      {money(inv.total, data.affectedCurrencies[0] ?? "SYP")}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {(data.cashDelta.syp !== 0 || data.cashDelta.usd !== 0) && (
              <div className="rounded-md border p-3">
                <p className="mb-1 font-semibold">أثر الصندوق:</p>
                <ul className="list-inside list-disc text-muted-foreground">
                  {data.cashDelta.syp !== 0 && <li>{money(data.cashDelta.syp, "ل.س")}</li>}
                  {data.cashDelta.usd !== 0 && <li>{money(data.cashDelta.usd, "$")}</li>}
                </ul>
                <p className="mt-2 text-xs text-muted-foreground">
                  Signs indicate the direction the drawer moves; balances and
                  receivables are recomputed immediately, with no page reload.
                </p>
              </div>
            )}

            {data.otherBlocked.length > 0 && (
              <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
                <p className="mb-1 font-semibold text-amber-600">
                  لن يُحذف (خارج نطاق هذه العملية):
                </p>
                <p className="text-muted-foreground">{data.otherBlocked.join("، ")}</p>
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              {hasFinancials
                ? "سيُنفَّذ كل ذلك داخل معاملة واحدة: أي خطأ يؤدي إلى تراجع كامل دون أي أثر متبقٍ."
                : "لا توجد توابع مالية — الحذف بسيط."}
            </p>

            <div className="space-y-2">
              <label htmlFor="dye-purge-confirm" className="font-semibold">
                للتأكيد اكتب: <code className="rounded bg-muted px-1">{expected}</code>{" "}
                أو اسم الصبغة
              </label>
              <Input
                id="dye-purge-confirm"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={expected}
                autoComplete="off"
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={purge.isPending}>
            إلغاء
          </Button>
          <Button
            variant="destructive"
            onClick={() => purge.mutate()}
            disabled={!canPurge}
          >
            {purge.isPending ? "جارٍ الحذف…" : "نعم، احذف كل شيء واضبط الحسابات"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
