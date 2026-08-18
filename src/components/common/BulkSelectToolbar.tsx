import { CheckSquare, X } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Reusable multi-select toolbar replicating the "bulk delete" pattern used in
 * the Inventory page. When idle it shows a single toggle button; once activated
 * it shows the selection count, a "select all" button, the bulk action button and
 * a close (exit) button.
 */
export function BulkSelectToolbar({
  active,
  count,
  idleLabel,
  actionLabel,
  canConfirm,
  canSelectAll,
  idleIcon: IdleIcon = CheckSquare,
  onEnter,
  onExit,
  onSelectAll,
  onAction,
  actionVariant = "destructive",
}: {
  active: boolean;
  count: number;
  idleLabel: string;
  actionLabel: string;
  canConfirm: boolean;
  canSelectAll: boolean;
  idleIcon?: typeof CheckSquare;
  onEnter: () => void;
  onExit: () => void;
  onSelectAll: () => void;
  onAction: () => void;
  actionVariant?: "destructive" | "default";
}) {
  if (!active) {
    return (
      <Button variant="outline" size="sm" onClick={onEnter} className="gap-2">
        <IdleIcon className="h-4 w-4" /> {idleLabel}
      </Button>
    );
  }

  return (
    <>
      <span className="text-sm font-semibold text-foreground tabular-nums">
        {count} محدد
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={onSelectAll}
        disabled={!canSelectAll}
      >
        تحديد الكل
      </Button>
      <Button
        variant={actionVariant}
        size="sm"
        disabled={!canConfirm}
        onClick={onAction}
      >
        {actionLabel}
      </Button>
      <Button variant="ghost" size="sm" onClick={onExit} title="إلغاء التحديد">
        <X className="h-4 w-4" />
      </Button>
    </>
  );
}