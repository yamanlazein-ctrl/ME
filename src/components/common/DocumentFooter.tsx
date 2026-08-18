import { Printer, PlusCircle, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { type ReactNode } from "react";

interface DocumentFooterProps {
  onSave: () => void;
  onSaveAndPrint?: () => void;
  onSaveAndNew?: () => void;
  onCancel?: () => void;
  saving?: boolean;
  saveLabel?: string;
  cancelLabel?: string;
  extra?: ReactNode;
}

export function DocumentFooter({
  onSave,
  onSaveAndPrint,
  onSaveAndNew,
  onCancel,
  saving,
  saveLabel = "حفظ",
  cancelLabel = "إلغاء",
  extra,
}: DocumentFooterProps) {
  return (
    <div className="sticky bottom-0 -mx-6 border-t border-border bg-card/95 px-6 py-3 backdrop-blur">
      <div className="flex items-center justify-between">
        {extra}
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={onCancel ?? (() => history.back())}
          >
            <X className="h-4 w-4 ml-1" /> {cancelLabel}
          </Button>
          {onSaveAndNew && (
            <Button
              variant="outline"
              onClick={onSaveAndNew}
              disabled={saving}
            >
              <PlusCircle className="h-4 w-4 ml-1" /> حفظ وجديد
            </Button>
          )}
          {onSaveAndPrint && (
            <Button
              variant="outline"
              onClick={onSaveAndPrint}
              disabled={saving}
            >
              <Printer className="h-4 w-4 ml-1" /> حفظ وطباعة
            </Button>
          )}
          <Button
            onClick={onSave}
            disabled={saving}
            className="bg-primary text-primary-foreground"
          >
            <Save className="h-4 w-4 ml-1" /> {saving ? "جارٍ الحفظ…" : saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
