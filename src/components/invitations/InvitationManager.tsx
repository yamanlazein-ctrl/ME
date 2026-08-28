import { useCallback, useEffect, useState } from "react";
import { Plus, Copy, Check, Ban, Ticket, RefreshCw, UserPlus, MonitorSmartphone } from "lucide-react";
import { toast } from "sonner";
import { PageCard } from "@/components/layout/PageCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  generateInvitation,
  listInvitations,
  revokeInvitation,
  type Invitation,
  type InvitationType,
} from "@/lib/invitations";

/**
 * Phase ج — admin invitation manager.
 *
 * Lets the system admin mint invitation codes and hand them to employees.
 * A `user` invitation carries the invitee's name/email/role and, when
 * accepted from the login screen, creates their account (and consumes a
 * device slot). A `device` invitation only registers a device.
 */

// Roles an admin can invite. Values must match the backend allow-list
// (admin/accountant/warehouse/viewer); labels are the owner-facing names.
const INVITABLE_ROLES: { value: string; label: string }[] = [
  { value: "accountant", label: "محاسب" },
  { value: "warehouse", label: "عامل" },
  { value: "viewer", label: "مساعد" },
];

const ROLE_LABEL: Record<string, string> = {
  admin: "مدير النظام",
  accountant: "محاسب",
  warehouse: "عامل",
  viewer: "مساعد",
};

export function InvitationManager() {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(false);

  // Generation form state
  const [type, setType] = useState<InvitationType>("user");
  const [targetName, setTargetName] = useState("");
  const [targetEmail, setTargetEmail] = useState("");
  const [targetRole, setTargetRole] = useState("accountant");
  const [ttlMinutes, setTtlMinutes] = useState(1440);
  const [issuing, setIssuing] = useState(false);
  const [issuedCode, setIssuedCode] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await listInvitations();
      setInvitations(rows);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل جلب الدعوات");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const issue = async () => {
    if (type === "user" && (!targetName.trim() || !targetEmail.trim())) {
      toast.error("اسم وبريد المدعو مطلوبان لدعوة مستخدم");
      return;
    }
    setIssuing(true);
    try {
      const row = await generateInvitation({
        type,
        ttlMinutes,
        targetName: type === "user" ? targetName.trim() : undefined,
        targetEmail: type === "user" ? targetEmail.trim() : undefined,
        targetRole: type === "user" ? targetRole : undefined,
      });
      setIssuedCode(row.code);
      setTargetName("");
      setTargetEmail("");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل إنشاء الدعوة");
    } finally {
      setIssuing(false);
    }
  };

  const revoke = async (inv: Invitation) => {
    if (!confirm(`إلغاء رمز الدعوة ${inv.code}؟`)) return;
    try {
      await revokeInvitation(inv.id);
      toast.success("تم إلغاء رمز الدعوة");
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "فشل إلغاء الدعوة");
    }
  };

  return (
    <PageCard
      title="رموز الدعوة"
      description="أنشئ رمز دعوة وسلّمه للموظف؛ يستخدمه من شاشة تسجيل الدخول لفتح حسابٍ له (ويستهلك جهازاً من حصة الترخيص)."
      noBodyPadding
      actions={
        <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className="h-4 w-4 ml-1" /> تحديث
        </Button>
      }
    >
      <div className="grid gap-4 p-4 lg:grid-cols-2">
        {/* ── Generation form ── */}
        <div className="space-y-3 rounded-lg border p-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <UserPlus className="h-4 w-4 text-primary" /> إنشاء رمز دعوة
          </div>

          <div className="grid gap-1.5">
            <Label>نوع الدعوة</Label>
            <Select value={type} onValueChange={(v) => setType(v as InvitationType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">مستخدم (حساب موظف)</SelectItem>
                <SelectItem value="device">جهاز فقط</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {type === "user" && (
            <>
              <div className="grid gap-1.5">
                <Label>اسم المدعو</Label>
                <Input value={targetName} onChange={(e) => setTargetName(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label>بريد المدعو</Label>
                <Input
                  type="email"
                  value={targetEmail}
                  onChange={(e) => setTargetEmail(e.target.value)}
                  placeholder="employee@erp.local"
                />
              </div>
              <div className="grid gap-1.5">
                <Label>الدور</Label>
                <Select value={targetRole} onValueChange={setTargetRole}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INVITABLE_ROLES.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          <div className="grid gap-1.5">
            <Label>مدة الصلاحية (دقائق)</Label>
            <Input
              type="number"
              min={1}
              max={1440}
              value={ttlMinutes}
              onChange={(e) => setTtlMinutes(Number(e.target.value))}
            />
          </div>

          <Button
            onClick={() => void issue()}
            disabled={issuing}
            className="w-full bg-primary text-primary-foreground"
          >
            <Plus className="h-4 w-4 ml-1" /> {issuing ? "جاري الإنشاء…" : "إنشاء الرمز"}
          </Button>

          {issuedCode && (
            <div className="flex items-center gap-2 rounded-lg border-2 border-primary/40 bg-primary/5 p-3">
              <code className="flex-1 text-center font-mono text-base font-bold tracking-widest text-primary">
                {issuedCode}
              </code>
              <CopyCode value={issuedCode} />
            </div>
          )}
        </div>

        {/* ── Invitation list ── */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Ticket className="h-4 w-4 text-primary" /> الدعوات الصادرة
          </div>
          {loading && invitations.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">جاري التحميل…</p>
          ) : invitations.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">لا توجد دعوات بعد</p>
          ) : (
            <div className="max-h-80 space-y-2 overflow-y-auto">
              {invitations.map((inv) => {
                const meta = inv.metadata ?? {};
                const used = inv.useCount >= 1;
                const expired = new Date(inv.expiresAt) < new Date();
                return (
                  <div key={inv.id} className="flex items-center gap-2 rounded-lg border p-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <code className="font-mono text-xs font-semibold tracking-wider">
                          {inv.code}
                        </code>
                        <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {inv.type === "user" ? "مستخدم" : "جهاز"}
                        </span>
                        {inv.type === "user" && Boolean(meta.targetRole) && (
                          <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {ROLE_LABEL[String(meta.targetRole)] ?? String(meta.targetRole)}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {inv.type === "user"
                          ? `${String(meta.targetName ?? "")} · ${String(meta.targetEmail ?? "")}`
                          : "دعوة جهاز"}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        {used ? "مُستخدَم" : expired ? "منتهي" : "صالح"} · ينتهي{" "}
                        {new Date(inv.expiresAt).toLocaleString("ar-SA")}
                      </div>
                    </div>
                    <CopyCode value={inv.code} />
                    {!used && !inv.revokedAt && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title="إلغاء"
                        onClick={() => void revoke(inv)}
                      >
                        <Ban className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </PageCard>
  );
}

function CopyCode({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      title="نسخ الرمز"
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
        <Check className="h-3.5 w-3.5 text-success" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </Button>
  );
}
