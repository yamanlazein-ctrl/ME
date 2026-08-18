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

export type BulkDeleteItem = {
  kind: "fabric" | "color" | "roll";
  id: string;
  name: string;
};

type DeleteTarget =
  | { kind: "fabric"; id: string; name: string }
  | { kind: "color"; id: string; name: string }
  | { kind: "roll"; id: string; name: string }
  | { kind: "bulk"; items: BulkDeleteItem[] }
  | null;

function ConfirmDelete({
  target,
  onCancel,
  onConfirm,
}: {
  target: DeleteTarget;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const isBulk = target?.kind === "bulk";
  const bulk = isBulk ? (target as { kind: "bulk"; items: BulkDeleteItem[] }).items : [];

  return (
    <AlertDialog open={!!target} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent dir="rtl">
        <AlertDialogHeader>
          <AlertDialogTitle>تأكيد الحذف</AlertDialogTitle>
          <AlertDialogDescription>
            {isBulk
              ? `هل أنت متأكد من حذف ${bulk.length} عنصر؟ لا يمكن التراجع عن هذا الإجراء.`
              : `هل أنت متأكد من حذف ${target?.name}؟ لا يمكن التراجع عن هذا الإجراء.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {isBulk && bulk.length > 0 && (
          <ul className="max-h-40 overflow-y-auto rounded-md border border-border bg-secondary/30 p-2 text-xs text-muted-foreground">
            {bulk.map((item) => (
              <li key={`${item.kind}:${item.id}`} className="truncate py-0.5">
                {item.kind === "fabric"
                  ? "قماش"
                  : item.kind === "color"
                    ? "لون"
                    : "صبغة"}
                {" — "}
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
            {isBulk ? `حذف ${bulk.length} عنصر` : "حذف نهائي"}
          </AlertDialogAction>
          <AlertDialogCancel>إلغاء</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export { ConfirmDelete, DeleteTarget };
