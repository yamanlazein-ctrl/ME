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
  addWarehouse,
  updateWarehouse,
  deleteWarehouse,
  type Warehouse,
} from "@/presentation/hooks/useSettings";

export const Route = createFileRoute("/settings/warehouses")({ component: WarehousesPage });

function WarehousesPage() {
  const s = useSettings();
  const [editing, setEditing] = useState<Warehouse | null>(null);
  const [open, setOpen] = useState(false);

  const openNew = () => {
    setEditing({ id: "", name: "", location: "", isDefault: false });
    setOpen(true);
  };
  const openEdit = (w: Warehouse) => {
    setEditing({ ...w });
    setOpen(true);
  };
  const save = () => {
    if (!editing || !editing.name.trim()) return;
    if (editing.id) updateWarehouse(editing.id, editing);
    else
      addWarehouse({
        name: editing.name.trim(),
        location: editing.location.trim(),
        isDefault: editing.isDefault,
      });
    setOpen(false);
  };

  return (
    <PageCard
      title="المستودعات"
      description="المستودعات المتاحة لتخزين المخزون."
      noBodyPadding
      actions={
        <Button size="sm" onClick={openNew} className="bg-primary text-primary-foreground">
          <Plus className="h-4 w-4 ml-1" /> إضافة مستودع
        </Button>
      }
    >
      <table className="w-full text-right text-sm">
        <thead className="bg-secondary/60 text-[11px] uppercase text-muted-foreground">
          <tr className="[&>th]:px-3 [&>th]:py-2.5">
            <th>الاسم</th>
            <th>الموقع</th>
            <th>افتراضي</th>
            <th className="text-left">إجراءات</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {s.warehouses.map((w) => (
            <tr key={w.id}>
              <td className="px-3 py-2">{w.name}</td>
              <td className="px-3 py-2">{w.location || "—"}</td>
              <td className="px-3 py-2">{w.isDefault ? "نعم" : "لا"}</td>
              <td className="px-3 py-2 text-left">
                <Button size="sm" variant="ghost" onClick={() => openEdit(w)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => confirm(`حذف "${w.name}"؟`) && deleteWarehouse(w.id)}
                  disabled={s.warehouses.length <= 1}
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </td>
            </tr>
          ))}
          {s.warehouses.length === 0 && (
            <tr>
              <td colSpan={4} className="p-8 text-center text-muted-foreground">
                لا مستودعات.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "تعديل مستودع" : "إضافة مستودع"}</DialogTitle>
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
                <Label>الموقع</Label>
                <Input
                  value={editing.location}
                  onChange={(e) => setEditing({ ...editing, location: e.target.value })}
                />
              </div>
              <div className="flex items-center justify-between rounded border p-2">
                <Label>افتراضي</Label>
                <Switch
                  checked={editing.isDefault}
                  onCheckedChange={(v) => setEditing({ ...editing, isDefault: v })}
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
