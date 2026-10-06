import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { container } from "@/infrastructure/container";
import { deleteColor, refreshInventory } from "@/presentation/hooks/useInventory";

export type ColorDeletionImpact = {
  colorId: string;
  colorName: string | null;
  rollsCount: number;
  stockMovementsCount: number;
  invoiceRefs: { kind: string; id: string; label: string }[];
  orderRefs: { kind: string; id: string; label: string }[];
  returnRefs: { kind: string; id: string; label: string }[];
  printJobRefs: { kind: string; id: string; label: string }[];
  canDelete: boolean;
  summaryLines: string[];
};

async function fetchColorImpact(colorId: string): Promise<ColorDeletionImpact> {
  const res = await container.http.get<ColorDeletionImpact>(
    `/api/inventory/colors/${colorId}/deletion-impact`,
  );
  return res.data;
}

/**
 * Color delete confirm: shows every live reference first. Safe deletes
 * (rolls / stock only) unlock confirm; linked invoices/orders stay blocked
 * with a precise Arabic list — never a bare "cannot delete".
 */
export function ColorDeleteDialog({
  colorId,
  colorName,
  open,
  onOpenChange,
}: {
  colorId: string | null;
  colorName: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const impact = useQuery({
    queryKey: ["color-deletion-impact", colorId],
    queryFn: () => fetchColorImpact(colorId!),
    enabled: open && Boolean(colorId),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const del = useMutation({
    mutationFn: async () => {
      if (!colorId) throw new Error("اللون غير محدد");
      await deleteColor(colorId);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      void refreshInventory();
      onOpenChange(false);
    },
  });

  const data = impact.data;
  const blocked = data ? !data.canDelete : false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dir="rtl" className="max-w-lg">
        <DialogHeader>
          <DialogTitle>حذف اللون{colorName ? ` «${colorName}»` : ""}</DialogTitle>
          <DialogDescription>
            يُفحص ارتباط اللون بالفواتير والطلبيات والصبغات قبل الحذف.
          </DialogDescription>
        </DialogHeader>

        {impact.isLoading && (
          <p className="text-sm text-muted-foreground">جاري فحص الارتباطات…</p>
        )}
        {impact.isError && (
          <p className="text-sm text-destructive">
            {impact.error instanceof Error ? impact.error.message : "تعذّر فحص الارتباطات"}
          </p>
        )}
        {data && (
          <div className="max-h-72 space-y-2 overflow-y-auto text-sm">
            {data.summaryLines.length === 0 ? (
              <p className="text-muted-foreground">لا توجد ارتباطات — يمكن الحذف بأمان.</p>
            ) : (
              <ul className="list-disc space-y-1 pr-5">
                {data.summaryLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            {(data.invoiceRefs.length > 0 ||
              data.orderRefs.length > 0 ||
              data.returnRefs.length > 0 ||
              data.printJobRefs.length > 0) && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                لا يمكن حذف اللون لوجود مستندات مالية/تشغيلية مرتبطة. ألغِ تلك المستندات أولاً أو
                استخدم الحذف التصحيحي للصبغة إن لزم.
              </div>
            )}
            {!blocked && data.rollsCount > 0 && (
              <p className="text-xs text-muted-foreground">
                سيتم حذف {data.rollsCount} صبغة و{data.stockMovementsCount} حركة مخزون مرتبطة داخل
                معاملة واحدة.
              </p>
            )}
          </div>
        )}

        <DialogFooter className="flex-row-reverse gap-2">
          <Button
            variant="destructive"
            disabled={!data?.canDelete || del.isPending || impact.isLoading}
            onClick={() => del.mutate()}
          >
            {del.isPending ? "جاري الحذف…" : "تأكيد الحذف"}
          </Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={del.isPending}>
            إلغاء
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
