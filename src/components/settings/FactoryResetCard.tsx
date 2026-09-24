import { useState } from "react";
import { toast } from "sonner";
import { PageCard } from "@/components/layout/PageCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requestFactoryReset } from "@/infrastructure/tauri-bridge";

/**
 * Field incident (2026-09): a one-click factory reset sat next to "فصل" on the
 * sync page; the next launch silently deleted pgdata — invoices and stock
 * vanished and only the part already pushed to the hub came back on pull.
 * A reset now needs the exact phrase typed, and the Rust side moves pgdata
 * aside (pgdata.reset-<time>) instead of deleting it.
 */
export const FACTORY_RESET_PHRASE = "احذف كل البيانات";

export function canConfirmFactoryReset(typed: string): boolean {
  return typed.trim() === FACTORY_RESET_PHRASE;
}

export function FactoryResetCard() {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <PageCard
      title="منطقة الخطر — إعادة الضبط المصنعي"
      description="ليست لفصل المزامنة. تُفرّغ قاعدة البيانات المحلية بالكامل عند التشغيل التالي (تُنقل القاعدة الحالية جانباً إلى مجلد pgdata.reset-… ولا تُحذف)."
    >
      {!open ? (
        <Button
          type="button"
          variant="outline"
          className="text-destructive"
          onClick={() => setOpen(true)}
        >
          إعادة ضبط مصنعي…
        </Button>
      ) : (
        <div className="space-y-3 rounded-md border border-destructive/40 p-3">
          <p className="text-sm text-destructive">
            ستبدأ بقاعدة بيانات فارغة: كل الفواتير والمخزون والسندات المحلية لن تظهر. للتأكيد اكتب
            العبارة التالية حرفياً: <strong>{FACTORY_RESET_PHRASE}</strong>
          </p>
          <Label htmlFor="factory-reset-phrase" className="sr-only">
            عبارة التأكيد
          </Label>
          <Input
            id="factory-reset-phrase"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant="destructive"
              disabled={!canConfirmFactoryReset(typed) || busy}
              onClick={() => {
                setBusy(true);
                requestFactoryReset()
                  .then(() => {
                    toast.success("طُلبت إعادة الضبط. ستُنفَّذ عند إعادة تشغيل البرنامج.");
                    setOpen(false);
                    setTyped("");
                  })
                  .catch((e: Error) => toast.error(e.message || "تعذّر طلب إعادة الضبط"))
                  .finally(() => setBusy(false));
              }}
            >
              تأكيد إعادة الضبط
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setOpen(false);
                setTyped("");
              }}
            >
              إلغاء
            </Button>
          </div>
        </div>
      )}
    </PageCard>
  );
}
