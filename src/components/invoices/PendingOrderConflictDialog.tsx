import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatQuantity } from "@/shared/utils/formatNumber";

export type ConflictInfo = {
  code: string;
  customerNameSnapshot: string;
  items: Array<{ fabricName: string; colorName: string; requestedKg: number }>;
};

interface PendingOrderConflictDialogProps {
  open: boolean;
  conflicts: ConflictInfo[];
  /** "متابعة وبيع الكمية" — the sale continues exactly as normal. */
  onProceed: () => void;
  /** "إلغاء الفاتورة" — the whole sale is aborted and the form resets. */
  onCancel: () => void;
}

/**
 * BUG-07 — interactive NON-BLOCKING warning (approved design):
 * tells the salesperson that the quantity they are about to sell is recorded
 * in a pending customer order. The sale is never technically locked — but it
 * cannot proceed without a conscious choice between the two buttons. Outside
 * clicks are swallowed so the dialog can't be dismissed without deciding;
 * Escape counts as "إلغاء الفاتورة".
 */
export function PendingOrderConflictDialog({
  open,
  conflicts,
  onProceed,
  onCancel,
}: PendingOrderConflictDialogProps) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        // Radix AlertDialog never dismisses on outside click; Escape is the
        // only dismissal path and it counts as "إلغاء الفاتورة".
        if (!o) onCancel();
      }}
    >
      <AlertDialogContent dir="rtl">
        <AlertDialogHeader>
          <AlertDialogTitle>تنبيه: كميات مرتبطة بطلبيات عملاء معلّقة</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm leading-6">
              {conflicts.map((c) =>
                c.items.map((it, i) => (
                  <p key={`${c.code}-${i}`}>
                    هذه الكمية مسجّلة ضمن طلبية معلّقة للعميل{" "}
                    <span className="font-bold text-foreground">{c.customerNameSnapshot}</span> —
                    رقم الطلبية <span className="font-bold text-foreground">{c.code}</span> (
                    {it.fabricName}/{it.colorName} — المطلوب {formatQuantity(it.requestedKg)} كغ).
                  </p>
                )),
              )}
              <p className="text-xs font-medium text-muted-foreground">
                الطلبية لن تتغيّر تلقائياً مهما كان قرارك.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="flex-row-reverse gap-2">
          <AlertDialogAction onClick={onProceed}>متابعة وبيع الكمية</AlertDialogAction>
          <AlertDialogCancel onClick={onCancel}>إلغاء الفاتورة</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
