import { useCallback, useEffect, useState, type FormEvent } from "react";
import logoUrl from "@/assets/logo-motard-icon.png";
import { persistTokens } from "@/infrastructure/auth/TokenProvider";
import { getApiBaseUrl } from "@/lib/api-base-url";
import {
  getInstallTenantId,
  setInstallTenantId,
  getDecryptedActivationId,
  getServerFingerprint,
  setActivationId as saveActivationId,
  setLicenseKey as saveLicenseKey,
} from "@/lib/license-state";
import { registerCurrentSyncDevice } from "@/lib/sync-device";
import { useQueryClient } from "@tanstack/react-query";
import { consumeInvitation, validateInvitation } from "@/lib/invitations";

type RosterUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  hasPin: boolean;
};

export function resolveTenantId(): string {
  return (
    getInstallTenantId() ?? (import.meta.env.VITE_DEFAULT_TENANT_ID as string | undefined) ?? ""
  );
}

type RosterResponse = {
  ok: boolean;
  status: number;
  tenantId?: string;
  users?: RosterUser[];
  message?: string;
  code?: string;
};

type PanelMode = "login" | "invite" | "recover";

async function fetchRoster(
  base: string,
  tid: string,
  headers: Record<string, string>,
): Promise<RosterResponse> {
  const r = await fetch(`${base}/api/auth/device-roster?tenantId=${encodeURIComponent(tid)}`, {
    headers,
  });
  const data = (await r.json().catch(() => ({}))) as {
    tenantId?: string;
    users?: RosterUser[];
    message?: string;
    code?: string;
  };
  return {
    ok: r.ok,
    status: r.status,
    tenantId: data.tenantId,
    users: data.users,
    message: data.message,
    code: data.code,
  };
}

async function recoverCompletedTenant(base: string): Promise<string | null> {
  const r = await fetch(`${base}/api/setup/status`);
  if (!r.ok) return null;
  const data = (await r.json().catch(() => ({}))) as {
    isCompleted?: boolean;
    tenantId?: string;
  };
  if (data.isCompleted === true && data.tenantId) return data.tenantId;
  return null;
}

const ROLE_AR: Record<string, string> = {
  admin: "مدير",
  accountant: "محاسب",
  warehouse: "مستودع",
  viewer: "مشاهد",
};

export function UserPickerPage() {
  const qc = useQueryClient();
  const [users, setUsers] = useState<RosterUser[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<RosterUser | null>(null);
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [panel, setPanel] = useState<PanelMode>("login");

  const [invCode, setInvCode] = useState("");
  const [invPin, setInvPin] = useState("");
  const [invConfirm, setInvConfirm] = useState("");

  const [recoverySecret, setRecoverySecret] = useState("");
  const [recoveryPin, setRecoveryPin] = useState("");
  const [recoveryConfirm, setRecoveryConfirm] = useState("");

  const loadRoster = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const tid = resolveTenantId();
      if (!tid) {
        setLoadError("لم يُعثر على معرّف الشركة. أكمل تفعيل الجهاز أولاً.");
        setUsers([]);
        return;
      }
      const base = getApiBaseUrl();
      const rosterHeaders: Record<string, string> = {};
      const activationId = await getDecryptedActivationId().catch(() => null);
      if (activationId) rosterHeaders["X-Device-Activation-Id"] = activationId;
      const fingerprint = await getServerFingerprint().catch(() => null);
      if (fingerprint) rosterHeaders["X-Device-Fingerprint"] = fingerprint;
      const data = await fetchRoster(base, tid, rosterHeaders);
      if (data.ok) {
        setTenantId(data.tenantId || tid);
        setUsers(Array.isArray(data.users) ? data.users : []);
        return;
      }
      if (data.status === 503 && data.code === "SETUP_REQUIRED") {
        const recovered = await recoverCompletedTenant(base);
        if (recovered && recovered !== tid) {
          setInstallTenantId(recovered);
          const retry = await fetchRoster(base, recovered, rosterHeaders);
          if (retry.ok) {
            setTenantId(retry.tenantId || recovered);
            setUsers(Array.isArray(retry.users) ? retry.users : []);
            return;
          }
          data.message = retry.message || data.message;
          data.code = retry.code;
          data.status = retry.status;
        }
      }
      if (data.status === 401 && data.code === "DEVICE_PROOF_REQUIRED") {
        setLoadError(
          "تعذّر التحقق من تفعيل هذا الجهاز. أعد المحاولة، وإن استمر الخطأ أعد تفعيل الجهاز من شاشة التفعيل.",
        );
        setUsers([]);
        return;
      }
      setLoadError(data.message || "تعذّر تحميل قائمة المستخدمين");
      setUsers([]);
    } catch {
      setLoadError("تعذّر الاتصال بالخادم");
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRoster();
  }, [loadRoster]);

  const finishLogin = async (accessToken: string, refreshToken?: string) => {
    persistTokens(accessToken, refreshToken);
    await registerCurrentSyncDevice().catch((err) => {
      console.warn("[sync-device] registration skipped:", err);
    });
    await qc.invalidateQueries({ queryKey: ["auth", "me"] });
  };

  const submitPin = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setError(null);
    if (!/^\d{4}$/.test(pin)) {
      setError("الرقم السري يجب أن يكون 4 أرقام");
      return;
    }
    if (!selected.hasPin) {
      if (pin !== confirmPin) {
        setError("تأكيد الرقم السري غير متطابق");
        return;
      }
    }
    setPending(true);
    try {
      const base = getApiBaseUrl();
      if (!selected.hasPin) {
        const setHeaders: Record<string, string> = { "Content-Type": "application/json" };
        const activationId = await getDecryptedActivationId().catch(() => null);
        if (activationId) setHeaders["X-Device-Activation-Id"] = activationId;
        const fingerprint = await getServerFingerprint().catch(() => null);
        if (fingerprint) setHeaders["X-Device-Fingerprint"] = fingerprint;
        const setRes = await fetch(`${base}/api/auth/set-pin`, {
          method: "POST",
          headers: setHeaders,
          body: JSON.stringify({
            userId: selected.id,
            pin,
            tenantId: tenantId || undefined,
          }),
        });
        if (!setRes.ok) {
          const body = (await setRes.json().catch(() => ({}))) as { message?: string };
          throw new Error(body.message || "فشل تعيين الرقم السري");
        }
      }
      const loginRes = await fetch(`${base}/api/auth/pin-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: selected.id,
          pin,
          tenantId: tenantId || undefined,
        }),
      });
      const body = (await loginRes.json().catch(() => ({}))) as {
        accessToken?: string;
        refreshToken?: string;
        message?: string;
      };
      if (!loginRes.ok || !body.accessToken) {
        throw new Error(body.message || "الرقم السري غير صحيح");
      }
      await finishLogin(body.accessToken, body.refreshToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "فشل الدخول");
    } finally {
      setPending(false);
    }
  };

  const submitInvite = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const code = invCode.trim().toUpperCase();
    if (!code) {
      setError("أدخل رمز الدعوة");
      return;
    }
    if (!/^\d{4}$/.test(invPin) || invPin !== invConfirm) {
      setError("الرقم السري يجب أن يكون 4 أرقام ومتطابقاً");
      return;
    }
    setPending(true);
    try {
      const v = await validateInvitation(code);
      if (!v.valid) throw new Error("رمز الدعوة غير صالح أو منتهٍ");
      const fingerprint = await getServerFingerprint().catch(() => undefined);
      const result = await consumeInvitation({
        code,
        password: v.type === "user" ? invPin : undefined,
        deviceFingerprint: fingerprint,
      });
      await saveLicenseKey(`INVITE:${code}`);
      await saveActivationId(result.tenantId || v.tenantId || code);
      if (result.tenantId) setInstallTenantId(result.tenantId);
      else if (v.tenantId) setInstallTenantId(v.tenantId);
      setPanel("login");
      setSelected(null);
      await loadRoster();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "فشل تفعيل الدعوة");
    } finally {
      setPending(false);
    }
  };

  const submitRecovery = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setError(null);
    if (!recoverySecret.trim()) {
      setError("أدخل كلمة مرور الحساب أو الرمز السابق لإثبات الهوية");
      return;
    }
    if (!/^\d{4}$/.test(recoveryPin) || recoveryPin !== recoveryConfirm) {
      setError("الرقم السري الجديد يجب أن يكون 4 أرقام ومتطابقاً");
      return;
    }
    setPending(true);
    try {
      const base = getApiBaseUrl();
      const setRes = await fetch(`${base}/api/auth/set-pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: selected.id,
          pin: recoveryPin,
          currentSecret: recoverySecret,
          tenantId: tenantId || undefined,
        }),
      });
      if (!setRes.ok) {
        const body = (await setRes.json().catch(() => ({}))) as { message?: string };
        throw new Error(
          body.message ||
            "تعذّرت الاستعادة — تحقق من كلمة مرور الحساب. لا تُحذف البيانات عند فشل الاستعادة.",
        );
      }
      const loginRes = await fetch(`${base}/api/auth/pin-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: selected.id,
          pin: recoveryPin,
          tenantId: tenantId || undefined,
        }),
      });
      const body = (await loginRes.json().catch(() => ({}))) as {
        accessToken?: string;
        refreshToken?: string;
        message?: string;
      };
      if (!loginRes.ok || !body.accessToken) {
        throw new Error(body.message || "تم تغيير الرقم السري لكن فشل الدخول التلقائي");
      }
      await finishLogin(body.accessToken, body.refreshToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "فشل استعادة الرقم السري");
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className="min-h-screen w-full bg-background text-foreground flex items-center justify-center px-4"
      dir="rtl"
    >
      <div className="relative w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-2xl">
        <div className="flex flex-col items-center text-center">
          <img
            src={logoUrl}
            alt="Motard Fabrics"
            className="h-16 w-16 object-contain object-center bg-transparent"
          />
          <h1 className="mt-4 text-2xl font-bold tracking-tight text-foreground">Motard Fabrics</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {panel === "invite"
              ? "تسجيل جهاز محاسب جديد"
              : panel === "recover"
                ? "استعادة الرقم السري"
                : "اختر المستخدم ثم أدخل الرقم السري"}
          </p>
        </div>

        {loading && panel === "login" && (
          <p className="mt-8 text-center text-sm text-muted-foreground">جاري تحميل المستخدمين…</p>
        )}

        {loadError && panel === "login" && (
          <div className="mt-6 space-y-3">
            <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {loadError}
            </p>
            <button
              type="button"
              onClick={() => void loadRoster()}
              className="w-full rounded-lg border border-border px-4 py-2 text-sm"
            >
              إعادة المحاولة
            </button>
          </div>
        )}

        {panel === "invite" && (
          <form onSubmit={submitInvite} className="mt-6 space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                رمز الدعوة
              </span>
              <input
                dir="ltr"
                value={invCode}
                onChange={(e) => setInvCode(e.target.value.toUpperCase())}
                className="w-full rounded-lg border border-border bg-secondary px-3 py-2.5 text-center tracking-widest outline-none focus:border-primary"
                placeholder="XXXX-XXXX"
                autoFocus
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                رقم سري جديد (4 أرقام)
              </span>
              <input
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={invPin}
                onChange={(e) => setInvPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                className="w-full rounded-lg border border-border bg-secondary px-3 py-2.5 text-center text-lg tracking-[0.4em] outline-none focus:border-primary"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                تأكيد الرقم السري
              </span>
              <input
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={invConfirm}
                onChange={(e) => setInvConfirm(e.target.value.replace(/\D/g, "").slice(0, 4))}
                className="w-full rounded-lg border border-border bg-secondary px-3 py-2.5 text-center text-lg tracking-[0.4em] outline-none focus:border-primary"
              />
            </label>
            {error && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={pending}
              className="w-full rounded-lg bg-primary px-4 py-3 text-sm font-bold text-primary-foreground disabled:opacity-60"
            >
              {pending ? "جاري التفعيل…" : "تفعيل والانضمام"}
            </button>
            <button
              type="button"
              className="w-full text-xs text-muted-foreground underline"
              onClick={() => {
                setPanel("login");
                setError(null);
              }}
            >
              العودة لتسجيل الدخول
            </button>
          </form>
        )}

        {panel === "recover" && selected && (
          <form onSubmit={submitRecovery} className="mt-6 space-y-4">
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              استعادة الوصول لـ <strong>{selected.name}</strong> دون حذف الفواتير أو العملاء أو
              قاعدة البيانات. أدخل كلمة مرور الحساب (أو الرمز السابق إن وُجد)، ثم عيّن رقماً سرياً
              جديداً من 4 أرقام.
            </p>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                كلمة مرور الحساب / السر الحالي
              </span>
              <input
                type="password"
                value={recoverySecret}
                onChange={(e) => setRecoverySecret(e.target.value)}
                className="w-full rounded-lg border border-border bg-secondary px-3 py-2.5 outline-none focus:border-primary"
                autoFocus
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                رقم سري جديد (4 أرقام)
              </span>
              <input
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={recoveryPin}
                onChange={(e) => setRecoveryPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                className="w-full rounded-lg border border-border bg-secondary px-3 py-2.5 text-center text-lg tracking-[0.4em] outline-none focus:border-primary"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                تأكيد الرقم السري الجديد
              </span>
              <input
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={recoveryConfirm}
                onChange={(e) => setRecoveryConfirm(e.target.value.replace(/\D/g, "").slice(0, 4))}
                className="w-full rounded-lg border border-border bg-secondary px-3 py-2.5 text-center text-lg tracking-[0.4em] outline-none focus:border-primary"
              />
            </label>
            {error && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={pending}
              className="w-full rounded-lg bg-primary px-4 py-3 text-sm font-bold text-primary-foreground disabled:opacity-60"
            >
              {pending ? "جاري الاستعادة…" : "تعيين الرقم السري والدخول"}
            </button>
            <button
              type="button"
              className="w-full text-xs text-muted-foreground underline"
              onClick={() => {
                setPanel("login");
                setError(null);
              }}
            >
              العودة
            </button>
          </form>
        )}

        {panel === "login" && !loading && !loadError && !selected && (
          <ul className="mt-6 space-y-2">
            {users.length === 0 ? (
              <li className="rounded-lg border border-border px-3 py-4 text-center text-sm text-muted-foreground">
                لا يوجد مستخدمون نشطون على هذا الجهاز بعد.
              </li>
            ) : (
              users.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelected(u);
                      setPin("");
                      setConfirmPin("");
                      setError(null);
                    }}
                    className="flex w-full items-center justify-between rounded-xl border border-border bg-secondary/50 px-4 py-3 text-start transition hover:border-primary/50 hover:bg-secondary"
                  >
                    <div>
                      <div className="text-sm font-bold text-foreground">{u.name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {ROLE_AR[u.role] ?? u.role}
                        {u.email ? ` · ${u.email}` : ""}
                      </div>
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      {u.hasPin ? "رقم سري" : "تعيين رقم سري"}
                    </span>
                  </button>
                </li>
              ))
            )}
            <li>
              <button
                type="button"
                onClick={() => {
                  setPanel("invite");
                  setError(null);
                }}
                className="mt-3 w-full rounded-lg border border-dashed border-primary/40 px-3 py-2.5 text-xs font-semibold text-primary"
              >
                تسجيل جهاز محاسب جديد عبر كود الدعوة
              </button>
            </li>
            <li>
              <button
                type="button"
                onClick={() => void loadRoster()}
                className="mt-2 w-full text-xs text-muted-foreground underline"
              >
                تحديث القائمة
              </button>
            </li>
          </ul>
        )}

        {panel === "login" && selected && (
          <form onSubmit={submitPin} className="mt-6 space-y-4">
            <div className="rounded-md border border-border bg-secondary px-3 py-2 text-sm">
              <span className="text-muted-foreground">المستخدم: </span>
              <span className="font-medium">{selected.name}</span>
              <button
                type="button"
                className="mr-3 text-xs text-primary underline"
                onClick={() => {
                  setSelected(null);
                  setError(null);
                }}
              >
                تغيير
              </button>
            </div>

            {!selected.hasPin && (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                أول دخول بعد التفعيل: عيّن رقماً سرياً من 4 أرقام. ستستخدمه في كل دخول لاحق على هذا
                الجهاز.
              </p>
            )}

            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                {selected.hasPin ? "الرقم السري (4 أرقام)" : "عيّن رقماً سرياً (4 أرقام)"}
              </span>
              <input
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                className="w-full rounded-lg border border-border bg-secondary px-3 py-2.5 text-center text-lg tracking-[0.4em] outline-none focus:border-primary"
                autoComplete="one-time-code"
                autoFocus
              />
            </label>

            {!selected.hasPin && (
              <label className="block">
                <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                  تأكيد الرقم السري
                </span>
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  value={confirmPin}
                  onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                  className="w-full rounded-lg border border-border bg-secondary px-3 py-2.5 text-center text-lg tracking-[0.4em] outline-none focus:border-primary"
                />
              </label>
            )}

            {error && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={pending}
              className="w-full rounded-lg bg-primary px-4 py-3 text-sm font-bold text-primary-foreground disabled:opacity-60"
            >
              {pending ? "جاري الدخول…" : selected.hasPin ? "دخول" : "تعيين الرقم السري والدخول"}
            </button>

            {selected.hasPin && (
              <button
                type="button"
                className="w-full text-xs text-muted-foreground underline"
                onClick={() => {
                  setPanel("recover");
                  setRecoverySecret("");
                  setRecoveryPin("");
                  setRecoveryConfirm("");
                  setError(null);
                }}
              >
                نسيت الرمز السري؟
              </button>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
