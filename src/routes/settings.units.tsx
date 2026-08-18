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
  addUnit,
  updateUnit,
  deleteUnit,
  type Unit,
} from "@/presentation/hooks/useSettings";

export const Route = createFileRoute("/settings/units")({ component: UnitsPage });

function UnitsPage() {
  const s = useSettings();
  const [editing, setEditing] = useState<Unit | null>(null);
  const [open, setOpen] = useState(false);

  const openNew = () => {
    setEditing({ id: "", name: "", symbol: "", isDefault: false });
    setOpen(true);
  };
  const openEdit = (u: Unit) => {
    setEditing({ ...u });
    setOpen(true);
  };
  const save = () => {
    if (!editing || !editing.name.trim() || !editing.symbol.trim()) return;
    if (editing.id) updateUnit(editing.id, editing);
    else
      addUnit({
        name: editing.name.trim(),
        symbol: editing.symbol.trim(),
        isDefault: editing.isDefault,
      });
    setOpen(false);
  };

  return (
    <PageCard
      title="وحدات القياس"
      description="الوحدات المستخدمة في المخزون والفواتير."
      noBodyPadding
      actions={
        <Button size="sm" onClick={openNew} className="bg-primary text-primary-foreground">
          <Plus className="h-4 w-4 ml-1" /> إضافة وحدة
        </Button>
      }
    >
      <table className="w-full text-right text-sm">
        <thead className="bg-secondary/60 text-[11px] uppercase text-muted-foreground">
          <tr className="[&>th]:px-3 [&>th]:py-2.5">
            <th>الاسم</th>
            <th>الرمز</th>
            <th>افتراضية</th>
            <th className="text-left">إجراءات</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {s.units.map((u) => (
            <tr key={u.id}>
              <td className="px-3 py-2">{u.name}</td>
              <td className="px-3 py-2">{u.symbol}</td>
              <td className="px-3 py-2">{u.isDefault ? "نعم" : "لا"}</td>
              <td className="px-3 py-2 text-left">
                <Button size="sm" variant="ghost" onClick={() => openEdit(u)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => confirm(`حذف الوحدة "${u.name}"؟`) && deleteUnit(u.id)}
                  disabled={s.units.length <= 1}
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </td>
            </tr>
          ))}
          {s.units.length === 0 && (
            <tr>
              <td colSpan={4} className="p-8 text-center text-muted-foreground">
                لا وحدات.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "تعديل وحدة" : "إضافة وحدة"}</DialogTitle>
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
                <Label>الرمز</Label>
                <Input
                  value={editing.symbol}
                  onChange={(e) => setEditing({ ...editing, symbol: e.target.value })}
                />
              </div>
              <div className="flex items-center justify-between rounded border p-2">
                <Label>افتراضية</Label>
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
