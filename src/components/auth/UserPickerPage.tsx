import { useCallback, useEffect, useState, type FormEvent } from "react";
import logoUrl from "@/assets/logo-motard-icon.png";
import { persistTokens } from "@/infrastructure/auth/TokenProvider";
import { DesktopServerSettings } from "@/components/auth/DesktopServerSettings";
import { getApiBaseUrl } from "@/lib/api-base-url";
import {
  getInstallTenantId,
  setInstallTenantId,
  getDecryptedActivationId,
  getServerFingerprint,
} from "@/lib/license-state";
import { registerCurrentSyncDevice } from "@/lib/sync-device";
import { useQueryClient } from "@tanstack/react-query";

type RosterUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  hasPin: boolean;
};

export function resolveTenantId(): string {
  // F08 (Phase 1 audit): the desktop-deploy branch used to check the
  // build-time VITE_DEFAULT_TENANT_ID BEFORE this device's own recorded
  // activation. That env var is baked into the installer at build time
  // (see .env.example) — every copy of the same build shares it. Once a
  // real tenant activates on a given machine (setInstallTenantId, written
  // during the actual activation flow), THAT is the tenant this device
  // belongs to; the baked constant must only be a last-resort fallback for
  // a machine that has never activated anything, exactly like the web
  // build already treats it below.
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
      // Stale local tenant from a half-finished wizard: the live install
      // is a different completed tenant. Recover from /api/setup/status.
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

  return (
    <div
      className="min-h-screen w-full bg-background text-foreground flex items-center justify-center px-4"
      dir="rtl"
    >
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-2xl">
        <div className="flex flex-col items-center text-center">
          <img
            src={logoUrl}
            alt=""
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
          </form>
        )}
      </div>
    </div>
  );
}
