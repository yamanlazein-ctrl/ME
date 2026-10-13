import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2, ShieldCheck, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { PageCard } from "@/components/layout/PageCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FormField } from "@/components/common/FormField";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
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
  ROLE_LABEL,
  ROLE_PERMISSIONS,
  hasAdminPrivileges,
  type UserRole,
} from "@/presentation/hooks/useSettings";
import { useCurrentUser } from "@/presentation/hooks/useAuth";
import { container } from "@/infrastructure/container";
import {
  changedUserFields,
  type TenantUserDTO,
  type UserDraft,
} from "@/infrastructure/api/UsersApiService";
import { InvitationManager } from "@/components/invitations/InvitationManager";

export const Route = createFileRoute("/settings/users")({ component: UsersPage });

type Draft = UserDraft;

const USERS_KEY = ["users"] as const;
const errMsg = (e: unknown, fallback: string) =>
  e instanceof Error && e.message ? e.message : fallback;

/**
 * hermes F-015: this page used to edit an in-memory list with no server call, so "added" users
 * vanished on reload and could never sign in. It now shows the tenant's real users
 * (`GET /api/users`), edits them with `PATCH`, and deactivates with `DELETE`. New accounts join
 * through an invitation code (InvitationManager below) — the backend has no direct-create endpoint,
 * and no secret is typed or kept here (C1-11).
 */
function UsersPage() {
  const { data: me } = useCurrentUser();
  const qc = useQueryClient();
  const isAdmin = hasAdminPrivileges(me?.role);
  // The admin role (granting it, or editing an admin account) stays with the admin — server-enforced.
  const adminReserved = me?.role !== "admin";
  const users = useQuery({
    queryKey: USERS_KEY,
    queryFn: () => container.users.api.list(),
    enabled: isAdmin,
  });
  const [editing, setEditing] = useState<{ draft: Draft; original: TenantUserDTO } | null>(null);
  const [removing, setRemoving] = useState<TenantUserDTO | null>(null);

  const save = useMutation({
    mutationFn: async ({ draft, original }: { draft: Draft; original: TenantUserDTO }) => {
      const patch = changedUserFields(draft, original);
      if (Object.keys(patch).length) await container.users.api.update(original.id, patch);
    },
    onSuccess: () => {
      toast.success("تم حفظ المستخدم");
      setEditing(null);
      void qc.invalidateQueries({ queryKey: USERS_KEY });
    },
    onError: (e) => toast.error(errMsg(e, "تعذّر حفظ المستخدم")),
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => container.users.api.deactivate(id),
    onSuccess: () => {
      toast.success("تم تعطيل المستخدم");
      void qc.invalidateQueries({ queryKey: USERS_KEY });
    },
    onError: (e) => toast.error(errMsg(e, "تعذّر تعطيل المستخدم")),
  });

  if (!me || !isAdmin) {
    return (
      <PageCard title="الوصول مرفوض" description="هذه الصفحة متاحة لمدير النظام والمحاسب فقط.">
        <div className="flex items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          <ShieldAlert className="h-5 w-5" />
          <span>ليس لديك صلاحية لإدارة المستخدمين.</span>
        </div>
      </PageCard>
    );
  }

  const list = users.data ?? [];
  const openEdit = (u: TenantUserDTO) =>
    setEditing({
      draft: { name: u.name, email: u.email, role: u.role, active: u.active },
      original: u,
    });
  const isSelf = editing?.original.id === me.id;

  return (
    <div className="space-y-4">
      <PageCard
        title="المستخدمون والصلاحيات"
        description="المستخدمون المسجّلون فعلاً على هذه الشركة. لإضافة موظف أنشئ له رمز دعوة أدناه؛ يُنشأ حسابه عند قبول الدعوة، ثم يدخل باختيار اسمه والرقم السري."
        noBodyPadding
      >
        <div className="overflow-x-auto">
          <table className="w-full text-right text-sm">
            <thead className="bg-secondary/60 text-[11px] uppercase text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-2.5">
                <th>الاسم</th>
                <th>الدور</th>
                <th>الحالة</th>
                <th>تاريخ الإنشاء</th>
                <th className="text-left">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {users.isLoading && (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-muted-foreground">
                    جارٍ تحميل المستخدمين…
                  </td>
                </tr>
              )}
              {users.isError && (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-destructive" role="alert">
                    {errMsg(users.error, "تعذّر تحميل المستخدمين")}{" "}
                    <Button size="sm" variant="outline" onClick={() => void users.refetch()}>
                      إعادة المحاولة
                    </Button>
                  </td>
                </tr>
              )}
              {list.map((u) => (
                <tr key={u.id}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{u.name}</div>
                    {u.email && (
                      <div className="text-xs text-muted-foreground font-mono">{u.email}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">{ROLE_LABEL[u.role]}</td>
                  <td className="px-3 py-2">
                    <span className={u.active ? "text-success" : "text-muted-foreground"}>
                      {u.active ? "مفعّل" : "موقوف"}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {u.createdAt.slice(0, 10)}
                  </td>
                  <td className="px-3 py-2 text-left">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`تعديل المستخدم ${u.name}`}
                      onClick={() => openEdit(u)}
                      disabled={adminReserved && u.role === "admin"}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`تعطيل المستخدم ${u.name}`}
                      onClick={() => setRemoving(u)}
                      disabled={
                        !u.active ||
                        u.id === me.id ||
                        deactivate.isPending ||
                        (adminReserved && u.role === "admin")
                      }
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

      {/* Only the admin creates invitation codes (server-enforced: ADMIN_ONLY). */}
      {!adminReserved && <InvitationManager />}

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title="تعطيل المستخدم"
        description={removing ? `سيُعطَّل حساب "${removing.name}" ولن يتمكن من الدخول.` : ""}
        confirmLabel="تعطيل"
        variant="destructive"
        onConfirm={() => {
          if (removing) deactivate.mutate(removing.id);
          setRemoving(null);
        }}
      />

      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>تعديل مستخدم</DialogTitle>
            <DialogDescription>
              عدّل الاسم أو البريد أو الدور أو حالة الحساب. الرقم السري يختاره الموظف بنفسه.
            </DialogDescription>
          </DialogHeader>
          {editing && (
            <div className="grid gap-3">
              <FormField label="الاسم">
                <Input
                  value={editing.draft.name}
                  onChange={(e) =>
                    setEditing({ ...editing, draft: { ...editing.draft, name: e.target.value } })
                  }
                />
              </FormField>
              <FormField label="البريد">
                <Input
                  type="email"
                  value={editing.draft.email}
                  onChange={(e) =>
                    setEditing({ ...editing, draft: { ...editing.draft, email: e.target.value } })
                  }
                />
              </FormField>
              <FormField label="الدور" htmlFor="user-role">
                <Select
                  value={editing.draft.role}
                  disabled={isSelf}
                  onValueChange={(v) =>
                    setEditing({ ...editing, draft: { ...editing.draft, role: v as UserRole } })
                  }
                >
                  <SelectTrigger id="user-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(ROLE_LABEL) as UserRole[]).map((r) => (
                      <SelectItem key={r} value={r} disabled={adminReserved && r === "admin"}>
                        {ROLE_LABEL[r]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <div className="flex items-center justify-between rounded-lg border px-3 py-2">
                <Label htmlFor="user-active">الحساب مفعّل</Label>
                <Switch
                  id="user-active"
                  checked={editing.draft.active}
                  disabled={isSelf}
                  onCheckedChange={(v) =>
                    setEditing({ ...editing, draft: { ...editing.draft, active: v } })
                  }
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              إلغاء
            </Button>
            <Button
              onClick={() => editing && save.mutate(editing)}
              disabled={!editing?.draft.name.trim() || save.isPending}
            >
              حفظ
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
