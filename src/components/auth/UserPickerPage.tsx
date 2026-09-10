import { useCallback, useEffect, useState, type FormEvent } from "react";
import logoUrl from "@/assets/logo-motard-icon.png";
import { persistTokens } from "@/infrastructure/auth/TokenProvider";
import { DesktopServerSettings } from "@/components/auth/DesktopServerSettings";
import { getApiBaseUrl } from "@/lib/api-base-url";
import { getInstallTenantId } from "@/lib/license-state";
import { registerCurrentSyncDevice } from "@/lib/sync-device";
import { useQueryClient } from "@tanstack/react-query";

type RosterUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  hasPin: boolean;
};

function resolveTenantId(): string {
  return (
    (import.meta.env.VITE_DESKTOP_DEPLOY === "true"
      ? (import.meta.env.VITE_DEFAULT_TENANT_ID as string | undefined)
      : null) ??
    getInstallTenantId() ??
    (import.meta.env.VITE_DEFAULT_TENANT_ID as string | undefined) ??
    ""
  );
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
  const [currentSecret, setCurrentSecret] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

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
      const r = await fetch(
        `${base}/api/auth/device-roster?tenantId=${encodeURIComponent(tid)}`,
      );
      const data = (await r.json().catch(() => ({}))) as {
        tenantId?: string;
        users?: RosterUser[];
        message?: string;
      };
      if (!r.ok) {
        setLoadError(data.message || "تعذّر تحميل قائمة المستخدمين");
        setUsers([]);
        return;
      }
      setTenantId(data.tenantId || tid);
      setUsers(Array.isArray(data.users) ? data.users : []);
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
      if (!currentSecret.trim()) {
        setError("أدخل كلمة المرور الحالية لتعيين الرقم السري");
        return;
      }
      if (pin !== confirmPin) {
        setError("تأكيد الرقم السري غير متطابق");
        return;
      }
    }
    setPending(true);
    try {
      const base = getApiBaseUrl();
      if (!selected.hasPin) {
        const setRes = await fetch(`${base}/api/auth/set-pin`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: selected.id,
            pin,
            currentSecret: currentSecret.trim(),
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

  return (
    <div
      className="min-h-screen w-full bg-background text-foreground flex items-center justify-center px-4"
      dir="rtl"
    >
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-2xl">
        <div className="flex flex-col items-center text-center">
          <img
            src={logoUrl}
            alt="Motard Fabrics Group"
            className="h-16 w-16 object-contain object-center bg-transparent"
          />
          <h1 className="mt-4 text-2xl font-bold tracking-tight text-foreground">
            Motard Fabrics Group
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">اختر المستخدم ثم أدخل الرقم السري</p>
        </div>

        <DesktopServerSettings />

        {loading && (
          <p className="mt-8 text-center text-sm text-muted-foreground">جاري تحميل المستخدمين…</p>
        )}

        {loadError && (
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

        {!loading && !loadError && !selected && (
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
                      setCurrentSecret("");
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
                onClick={() => void loadRoster()}
                className="mt-2 w-full text-xs text-muted-foreground underline"
              >
                تحديث القائمة
              </button>
            </li>
          </ul>
        )}

        {selected && (
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
              <>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  أول دخول لهذا الحساب: أدخل كلمة المرور الحالية ثم عيّن رقماً سرياً من 4 أرقام.
                </p>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                    كلمة المرور الحالية
                  </span>
                  <input
                    type="password"
                    value={currentSecret}
                    onChange={(e) => setCurrentSecret(e.target.value)}
                    className="w-full rounded-lg border border-border bg-secondary px-3 py-2.5 text-sm outline-none focus:border-primary"
                    autoComplete="current-password"
                    autoFocus
                  />
                </label>
              </>
            )}

            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                {selected.hasPin ? "الرقم السري (4 أرقام)" : "رقم سري جديد (4 أرقام)"}
              </span>
              <input
                type="password"
                inputMode="numeric"
                maxLength={4}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                className="w-full rounded-lg border border-border bg-secondary px-3 py-2.5 text-center text-lg tracking-[0.4em] outline-none focus:border-primary"
                autoComplete="one-time-code"
                autoFocus={selected.hasPin}
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
              {pending
                ? "جاري الدخول…"
                : selected.hasPin
                  ? "دخول"
                  : "تعيين الرقم السري والدخول"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
