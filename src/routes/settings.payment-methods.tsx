import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { PageCard } from "@/components/layout/PageCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  useSettings,
  addPaymentMethod,
  updatePaymentMethod,
  deletePaymentMethod,
  type PaymentMethod,
} from "@/presentation/hooks/useSettings";

export const Route = createFileRoute("/settings/payment-methods")({
  component: PaymentMethodsPage,
});

function PaymentMethodsPage() {
  const s = useSettings();
  const [editing, setEditing] = useState<PaymentMethod | null>(null);
  const [open, setOpen] = useState(false);

  const openNew = () => {
    setEditing({ id: "", name: "", enabled: true });
    setOpen(true);
  };
  const openEdit = (p: PaymentMethod) => {
    setEditing({ ...p });
    setOpen(true);
  };
  const save = () => {
    if (!editing || !editing.name.trim()) return;
    if (editing.id) updatePaymentMethod(editing.id, editing);
    else addPaymentMethod({ name: editing.name.trim(), enabled: editing.enabled });
    setOpen(false);
  };

  return (
    <PageCard
      title="طرق الدفع"
      description="طرق الدفع المتاحة عند إنشاء السندات والفواتير."
      noBodyPadding
      actions={
        <Button size="sm" onClick={openNew} className="bg-primary text-primary-foreground">
          <Plus className="h-4 w-4 ml-1" /> إضافة طريقة
        </Button>
      }
    >
      <table className="w-full text-right text-sm">
        <thead className="bg-secondary/60 text-[11px] uppercase text-muted-foreground">
          <tr className="[&>th]:px-3 [&>th]:py-2.5">
            <th>الاسم</th>
            <th>الحالة</th>
            <th className="text-left">إجراءات</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {s.paymentMethods.map((p) => (
            <tr key={p.id}>
              <td className="px-3 py-2">{p.name}</td>
              <td className="px-3 py-2">{p.enabled ? "مفعّلة" : "معطّلة"}</td>
              <td className="px-3 py-2 text-left">
                <Button size="sm" variant="ghost" onClick={() => openEdit(p)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => confirm(`حذف "${p.name}"؟`) && deletePaymentMethod(p.id)}
                  disabled={s.paymentMethods.length <= 1}
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "تعديل طريقة دفع" : "إضافة طريقة دفع"}</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="grid gap-3">
              <div className="grid gap-1.5">
                <Label>الاسم</Label>
                <Input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
              </div>
              <div className="flex items-center justify-between rounded border p-2">
                <Label>مفعّلة</Label>
                <Switch
                  checked={editing.enabled}
                  onCheckedChange={(v) => setEditing({ ...editing, enabled: v })}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              إلغاء
            </Button>
            <Button onClick={save} className="bg-primary text-primary-foreground">
              حفظ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageCard>
  );
}
