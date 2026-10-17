import { useState } from "react";
import { Download, FileText, Printer } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { PartyKind } from "./PartyFormDialog";

export type PartyExportFormat = "excel" | "pdf";

/**
 * Confirmation step for "طباعة / تصدير الكل". The user picks the output; the page then exports
 * ALL parties (not the 20-row view) through `onChoose`.
 */
export function PartyExportDialog({
  open,
  kind,
  count,
  onClose,
  onChoose,
}: {
  open: boolean;
  kind: PartyKind;
  count: number;
  onClose: () => void;
  onChoose: (format: PartyExportFormat) => void;
}) {
  const [busy, setBusy] = useState(false);
  const label = kind === "supplier" ? "الموردين" : "العملاء";

  const choose = (format: PartyExportFormat) => {
    setBusy(true);
    try {
      onChoose(format);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" dir="rtl">
        <DialogHeader>
          <DialogTitle>طباعة / تصدير الكل</DialogTitle>
          <DialogDescription>
            سيتم تصدير جميع {label} ({count}) في سطر واحد لكل سجل، مع الأرصدة لكل عملة على حدة. لا
            تُدمج العملات في رقم واحد.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy || count === 0}
            onClick={() => choose("excel")}
            className="h-auto justify-start gap-3 py-3 text-right"
          >
            <Download className="h-5 w-5" />
            <span className="flex flex-col items-start">
              <span className="font-semibold">تصدير Excel (CSV)</span>
              <span className="text-xs text-muted-foreground">
                ملف جدول يُفتح في Excel مباشرة، بترميز UTF-8 يحفظ العربية
              </span>
            </span>
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || count === 0}
            onClick={() => choose("pdf")}
            className="h-auto justify-start gap-3 py-3 text-right"
          >
            <Printer className="h-5 w-5" />
            <span className="flex flex-col items-start">
              <span className="font-semibold">طباعة / PDF</span>
              <span className="text-xs text-muted-foreground">
                يفتح نافذة الطباعة؛ اختر «حفظ كـ PDF» من الطابعة لإنشاء ملف PDF
              </span>
            </span>
          </Button>
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            <FileText className="ml-1 h-4 w-4" />
            إلغاء
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
