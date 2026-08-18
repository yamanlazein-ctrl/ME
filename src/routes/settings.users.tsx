import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  Pencil,
  Plus,
  Trash2,
  ShieldCheck,
  Copy,
  RefreshCw,
  ShieldAlert,
  Check,
} from "lucide-react";
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
  DialogDescription,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useSettings,
  addUser,
  updateUser,
  deleteUser,
  regenerateLicenseKey,
  ROLE_LABEL,
  ROLE_PERMISSIONS,
  type SystemUser,
  type UserRole,
} from "@/presentation/hooks/useSettings";
import { useCurrentUser } from "@/presentation/hooks/useAuth";

export const Route = createFileRoute("/settings/users")({ component: UsersPage });

type Draft = {
  id: string;
  name: string;
  email: string;
  password: string;
  role: UserRole;
  active: boolean;
};

const EMPTY: Draft = {
  id: "",
  name: "",
  email: "",
  password: "",
  role: "accountant",
  active: true,
};

function UsersPage() {
  const s = useSettings();
  const { data: me } = useCurrentUser();
  const [editing, setEditing] = useState<Draft | null>(null);
  const [open, setOpen] = useState(false);
  const [issuedKey, setIssuedKey] = useState<{ key: string; name: string } | null>(null);

  if (!me || me.role !== "admin") {
    return (
      <PageCard title="الوصول مرفوض" description="هذه الصفحة متاحة لمدير النظام فقط.">
        <div className="flex items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          <ShieldAlert className="h-5 w-5" />
          <span>ليس لديك صلاحية لإدارة المستخدمين والمفاتيح.</span>
        </div>
      </PageCard>
    );
  }

  const openNew = () => {
    setEditing({ ...EMPTY });
    setOpen(true);
  };
  const openEdit = (u: SystemUser) => {
    setEditing({
      id: u.id,
      name: u.name,
      email: u.email,
      password: u.password ?? "",
      role: u.role,
      active: u.active,
    });
    setOpen(true);
  };
  const save = () => {
    if (!editing || !editing.name.trim()) return;
    if (editing.id) {
      updateUser(editing.id, {
        name: editing.name.trim(),
        email: editing.email.trim(),
        password: editing.password || undefined,
        role: editing.role,
        active: editing.active,
      });
      setOpen(false);
    } else {
      const u = addUser({
        name: editing.name.trim(),
        email: editing.email.trim(),
        password: editing.password || undefined,
        role: editing.role,
        active: editing.active,
      });
      setOpen(false);
      setIssuedKey({ key: u.licenseKey, name: u.name });
    }
  };

  return (
    <div className="space-y-4">
      <PageCard
        title="المستخدمون والصلاحيات"
        description="أنشئ حساباً للمستخدم واختر دوره؛ يولّد النظام مفتاح تفعيل يُعطى له لفتح البرنامج بصلاحياته فقط."
        noBodyPadding
        actions={
          <Button size="sm" onClick={openNew} className="bg-primary text-primary-foreground">
            <Plus className="h-4 w-4 ml-1" /> إضافة مستخدم
          </Button>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-right text-sm">
            <thead className="bg-secondary/60 text-[11px] uppercase text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-2.5">
                <th>الاسم</th>
                <th>الدور</th>
                <th>مفتاح التفعيل</th>
                <th>الحالة</th>
                <th>تاريخ الإنشاء</th>
                <th className="text-left">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {s.users.map((u) => (
                <tr key={u.id}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{u.name}</div>
                    {u.email && (
                      <div className="text-xs text-muted-foreground font-mono">{u.email}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">{ROLE_LABEL[u.role]}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1">
                      <code className="rounded bg-secondary px-2 py-0.5 text-[11px] font-mono tracking-wider">
                        {u.licenseKey}
                      </code>
                      <CopyBtn value={u.licenseKey} />
                      <Button
                        size="sm"
                        variant="ghost"
                        title="توليد مفتاح جديد"
                        onClick={() => {
                          if (!confirm(`استبدال مفتاح ${u.name}؟ سيتوقف المفتاح القديم عن العمل.`))
                            return;
                          const k = regenerateLicenseKey(u.id);
                          if (k) setIssuedKey({ key: k, name: u.name });
                        }}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <span className={u.active ? "text-success" : "text-muted-foreground"}>
                      {u.active ? "مفعّل" : "موقوف"}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {u.createdAt}
                  </td>
                  <td className="px-3 py-2 text-left">
                    <Button size="sm" variant="ghost" onClick={() => openEdit(u)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => confirm(`حذف المستخدم "${u.name}"؟`) && deleteUser(u.id)}
                      disabled={s.users.length <= 1 || u.id === me.id}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </PageCard>

      <PageCard title="مصفوفة الصلاحيات" description="ما يستطيع كل دور فعله داخل النظام.">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {(Object.keys(ROLE_LABEL) as UserRole[]).map((role) => (
            <div key={role} className="rounded-lg border p-3">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <ShieldCheck className="h-4 w-4 text-primary" />
                {ROLE_LABEL[role]}
              </div>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {ROLE_PERMISSIONS[role].map((p) => (
                  <li key={p}>• {p}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </PageCard>

      {/* Add / Edit dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "تعديل مستخدم" : "إضافة مستخدم"}</DialogTitle>
            <DialogDescription>
              اختر الدور المناسب. عند الحفظ يُولَّد مفتاح تفعيل يمنح هذا المستخدم صلاحيات دوره فقط.
            </DialogDescription>
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
                <Label>البريد (اختياري)</Label>
                <Input
                  type="email"
                  value={editing.email}
                  onChange={(e) => setEditing({ ...editing, email: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>كلمة المرور (اختياري — للدخول بالحساب)</Label>
                <Input
                  type="text"
                  value={editing.password}
                  onChange={(e) => setEditing({ ...editing, password: e.target.value })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>الدور</Label>
                <Select
                  value={editing.role}
                  onValueChange={(v) => setEditing({ ...editing, role: v as UserRole })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(ROLE_LABEL) as UserRole[]).map((r) => (
                      <SelectItem key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between rounded border p-2">
                <Label>مفعّل</Label>
                <Switch
                  checked={editing.active}
                  onCheckedChange={(v) => setEditing({ ...editing, active: v })}
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

      {/* Issued-key dialog */}
      <Dialog open={!!issuedKey} onOpenChange={(v) => !v && setIssuedKey(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>مفتاح التفعيل جاهز</DialogTitle>
            <DialogDescription>
              أعطِ هذا المفتاح للمستخدم <b>{issuedKey?.name}</b>. سيستخدمه في تبويب «التفعيل بمفتاح
              الترخيص» لفتح البرنامج.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-lg border-2 border-primary/40 bg-primary/5 p-3">
            <code className="flex-1 text-center text-base font-mono font-bold tracking-widest text-primary">
              {issuedKey?.key}
            </code>
            {issuedKey && <CopyBtn value={issuedKey.key} large />}
          </div>
          <DialogFooter>
            <Button
              onClick={() => setIssuedKey(null)}
              className="bg-primary text-primary-foreground"
            >
              تم
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CopyBtn({ value, large }: { value: string; large?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      title="نسخ"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* ignore */
        }
      }}
    >
      {done ? (
        <Check className={large ? "h-5 w-5 text-success" : "h-3.5 w-3.5 text-success"} />
      ) : (
        <Copy className={large ? "h-5 w-5" : "h-3.5 w-3.5"} />
      )}
    </Button>
  );
}
