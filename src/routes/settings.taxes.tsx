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
  addTax,
  updateTax,
  deleteTax,
  type Tax,
} from "@/presentation/hooks/useSettings";

export const Route = createFileRoute("/settings/taxes")({ component: TaxesPage });

function TaxesPage() {
  const s = useSettings();
  const [editing, setEditing] = useState<Tax | null>(null);
  const [open, setOpen] = useState(false);

  const openNew = () => {
    setEditing({ id: "", name: "", rate: 0, enabled: true });
    setOpen(true);
  };
  const openEdit = (t: Tax) => {
    setEditing({ ...t });
    setOpen(true);
  };
  const save = () => {
    if (!editing || !editing.name.trim()) return;
    if (editing.id) updateTax(editing.id, editing);
    else
      addTax({
        name: editing.name.trim(),
        rate: Number(editing.rate) || 0,
        enabled: editing.enabled,
      });
    setOpen(false);
  };

  return (
    <PageCard
      title="الضرائب"
      description="الضرائب المطبقة على الفواتير."
      noBodyPadding
      actions={
        <Button size="sm" onClick={openNew} className="bg-primary text-primary-foreground">
          <Plus className="h-4 w-4 ml-1" /> إضافة ضريبة
        </Button>
      }
    >
      <table className="w-full text-right text-sm">
        <thead className="bg-secondary/60 text-[11px] uppercase text-muted-foreground">
          <tr className="[&>th]:px-3 [&>th]:py-2.5">
            <th>الاسم</th>
            <th>النسبة %</th>
            <th>الحالة</th>
            <th className="text-left">إجراءات</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {s.taxes.map((t) => (
            <tr key={t.id}>
              <td className="px-3 py-2">{t.name}</td>
              <td className="px-3 py-2">{t.rate}%</td>
              <td className="px-3 py-2">{t.enabled ? "مفعّلة" : "معطّلة"}</td>
              <td className="px-3 py-2 text-left">
                <Button size="sm" variant="ghost" onClick={() => openEdit(t)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => confirm(`حذف "${t.name}"؟`) && deleteTax(t.id)}
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </td>
            </tr>
          ))}
          {s.taxes.length === 0 && (
            <tr>
              <td colSpan={4} className="p-8 text-center text-muted-foreground">
                لا ضرائب.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "تعديل ضريبة" : "إضافة ضريبة"}</DialogTitle>
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
              <div className="grid gap-1.5">
                <Label>النسبة %</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={editing.rate}
                  onChange={(e) => setEditing({ ...editing, rate: Number(e.target.value) })}
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
