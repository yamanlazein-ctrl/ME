import type { ReactNode } from "react";
import { Printer, Save, Plus, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Standard save-completing footer PATTERN.
 * Applied per screen (not a fully abstracted global component yet) — the
 * screen owns its save handlers, this component owns the visual contract:
 *
 *   [ إلغاء ]   .....   [ حفظ وطباعة ]  [ حفظ وإضافة جديد ]  [ حفظ والرجوع ]  [ حفظ ]
 *
 * `onSave` is required (primary). All others are optional; omit to hide.
 */
export function DocumentFooter({
  onSave,
  onSaveAndPrint,
  onSaveAndNew,
  onSaveAndBack,
  onCancel,
  isSaving,
  saveLabel = "حفظ",
  disabled,
  extra,
  className,
}: {
  onSave: () => void;
  onSaveAndPrint?: () => void;
  onSaveAndNew?: () => void;
  onSaveAndBack?: () => void;
  onCancel?: () => void;
  isSaving?: boolean;
  saveLabel?: string;
  disabled?: boolean;
  extra?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-print-hide
      className={cn(
        "sticky bottom-0 z-20 -mx-6 mt-4 border-t border-border bg-background/95 px-4 py-2.5 backdrop-blur",
        "supports-[backdrop-filter]:bg-background/80",
        className,
      )}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {onCancel && (
            <Button type="button" variant="ghost" onClick={onCancel} disabled={isSaving}>
              إلغاء
            </Button>
          )}
          {extra}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onSaveAndPrint && (
            <Button
              type="button"
              variant="outline"
              onClick={onSaveAndPrint}
              disabled={disabled || isSaving}
              className="gap-1.5"
            >
              <Printer className="h-4 w-4" /> حفظ وطباعة
            </Button>
          )}
          {onSaveAndNew && (
            <Button
              type="button"
              variant="outline"
              onClick={onSaveAndNew}
              disabled={disabled || isSaving}
              className="gap-1.5"
            >
              <Plus className="h-4 w-4" /> حفظ وإضافة جديد
            </Button>
          )}
          {onSaveAndBack && (
            <Button
              type="button"
              variant="outline"
              onClick={onSaveAndBack}
              disabled={disabled || isSaving}
              className="gap-1.5"
            >
              <ArrowRight className="h-4 w-4" /> حفظ والرجوع
            </Button>
          )}
          <Button
            type="button"
            onClick={onSave}
            disabled={disabled || isSaving}
            className="gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Save className="h-4 w-4" /> {isSaving ? "جارٍ الحفظ..." : saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
