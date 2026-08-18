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

export type BulkActionItem = {
  key: string;
  name: string;
};

/**
 * Generic confirmation dialog for a bulk action (delete / cancel). Shows the
 * count and a scrollable list of the affected items. Reuses the exact visual
 * pattern of the Inventory `ConfirmDelete` dialog.
 */
export function ConfirmBulkAction({
  open,
  title,
  description,
  confirmLabel,
  items,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  items: BulkActionItem[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent dir="rtl">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {items.length > 0 && (
          <ul className="max-h-40 overflow-y-auto rounded-md border border-border bg-secondary/30 p-2 text-xs text-muted-foreground">
            {items.map((item) => (
              <li key={item.key} className="truncate py-0.5">
                {item.name}
              </li>
            ))}
          </ul>
        )}
        <AlertDialogFooter className="flex-row-reverse gap-2">
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {confirmLabel}
          </AlertDialogAction>
          <AlertDialogCancel>إلغاء</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}