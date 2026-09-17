import { useEffect, useState, type FormEvent, type MouseEvent } from "react";
import logoUrl from "@/assets/logo-motard-icon.png";
import { DesktopServerSettings } from "@/components/auth/DesktopServerSettings";
import {
  setActivationId as saveActivationId,
  setLicenseKey as saveLicenseKey,
  setInstallTenantId,
  getInstallTenantId,
  getActivationDeviceInfo,
  getServerFingerprint,
} from "@/lib/license-state";
import { getApiBaseUrl } from "@/lib/api-base-url";
import { validateInvitation, consumeInvitation } from "@/lib/invitations";
import { cn } from "@/lib/utils";

/**
 * R3 — full Setup Wizard for the customer ERP frontend.
 *
 * Drives the backend setup flow end-to-end so that a real Owner user is
 * created (completeWizardUseCase → R1) and the customer can subsequently
 * log in. Replaces the old standalone activation screen that only talked
 * to the License Server's /v1/activations (which 404s on the customer
 * backend).
 *
 * Steps: activate → (optional bootstrap password) → done.
 * License key from the owner dashboard unlocks the install; empty DBs then
 * only ask for an admin password (company is taken from the license).
 */
const API_BASE = getApiBaseUrl("");
const SETUP_TOKEN = import.meta.env.VITE_SETUP_TOKEN as string | undefined;

// Desktop pre-baked build: the license is baked into the bundled DB and
// activated verify-only at runtime — there is no key for the customer to enter.
// After activate succeeds we mark setup complete and open login (seed already
// has company + admin); we do NOT collect company/admin again.
const isDesktopPreBaked = import.meta.env.VITE_DESKTOP_DEPLOY === "true";

type Step = "activate" | "bootstrap" | "done";

function mapBackendStep(currentStep: string | undefined): Step | null {
  switch (currentStep) {
    case "company":
    case "localization":
    case "admin":
    case "review":
      return "bootstrap";
    case "done":
      return "done";
    default:
      return null;
  }
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (SETUP_TOKEN) h["X-Setup-Token"] = SETUP_TOKEN;
  return h;
}

async function apiPost(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: any }> {
  const url = `${API_BASE}${path}`;
  const r = await fetch(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

export function ActivationScreen({ onActivated }: { onActivated: () => void }) {
  const [step, setStep] = useState<Step>("activate");
  const [tenantId, setTenantId] = useState<string>(() => getInstallTenantId() ?? "");
  const [pendingActivationId, setPendingActivationId] = useState("");
  const [licenseKey, setLicenseKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [activateMode, setActivateMode] = useState<"license" | "invitation">("license");
  const [invCode, setInvCode] = useState("");
  const [invPassword, setInvPassword] = useState("");
  const [invError, setInvError] = useState<string | null>(null);
  const [invSuccess, setInvSuccess] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`${API_BASE}/api/setup/status`);
        if (!r.ok) return;
        const data = (await r.json()) as { currentStep?: string; isCompleted?: boolean };
        if (cancelled) return;
        // N1: never skip via isCompleted alone — only local isActivated() (Gate)
        // opens the app. Persist markers first if finishing a mid-wizard desktop install.
        if (
          isDesktopPreBaked &&
          data?.isCompleted !== true &&
          data?.currentStep &&
          data.currentStep !== "welcome" &&
          data.currentStep !== "activate"
        ) {
          const tid = getInstallTenantId() || (await ensureTenant());
          const cp = await apiPost("/api/setup/wizard/complete", { tenantId: tid });
          if (cp.ok || cp.data?.code === "ALREADY_COMPLETED" || cp.status === 409) {
            await saveLicenseKey("DESKTOP");
            await saveActivationId(tid);
            setStep("done");
            onActivated();
            return;
          }
        }
        const mapped = mapBackendStep(data?.currentStep);
        if (mapped && mapped !== "done" && !isDesktopPreBaked) setStep(mapped);
      } catch {
        /* stay on activate */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Bootstrap after license (empty DB): password only — company comes from license.
  const [companyName, setCompanyName] = useState("شركتي");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminPasswordConfirm, setAdminPasswordConfirm] = useState("");
  const [rememberYear, setRememberYear] = useState(true);

  async function submitInvitation(e: FormEvent) {
    e.preventDefault();
    setInvError(null);
    setInvSuccess(null);
    const code = invCode.trim().toUpperCase();
    if (!code) {
      setInvError("الرجاء إدخال رمز الدعوة");
      return;
    }
    if (invPassword.length !== 4 || !/^\d{4}$/.test(invPassword)) {
      setInvError("الرقم السري يجب أن يكون 4 أرقام");
      return;
    }
    setLoading(true);
    try {
      const v = await validateInvitation(code);
      if (!v.valid) {
        setInvError("رمز الدعوة غير صالح أو منتهٍ");
        return;
      }
      const fingerprint = await getServerFingerprint().catch(() => undefined);
      const result = await consumeInvitation({
        code,
        password: v.type === "user" ? invPassword : undefined,
        deviceFingerprint: fingerprint,
      });
      await saveLicenseKey(`INVITE:${code}`);
      await saveActivationId(result.tenantId || v.tenantId || code);
      if (result.tenantId) setInstallTenantId(result.tenantId);
      else if (v.tenantId) setInstallTenantId(v.tenantId);
      setInvSuccess("تم تفعيل الدعوة. اختر اسمك من قائمة المستخدمين.");
      setTimeout(() => onActivated(), 800);
    } catch (err) {
      setInvError(err instanceof Error ? err.message : "فشل تفعيل رمز الدعوة");
    } finally {
      setLoading(false);
    }
  }

  async function ensureTenant(): Promise<string> {
    if (tenantId) return tenantId;
    const r = await apiPost("/api/setup/init", {});
    if (!r.ok) throw new Error("تعذّر تهيئة التثبيت");
    const id = r.data?.tenantId ?? r.data?.id;
    if (!id) throw new Error("استجابة غير صالحة من الخادم");
    setTenantId(id);
    setInstallTenantId(id);
    return id;
  }

  async function submitActivate(e?: FormEvent | MouseEvent) {
    e?.preventDefault();
    setError(null);
    // Do NOT force uppercase: keys are stored/looked up case-sensitively.
    // Admin-issued LIC-… keys are already uppercase; uppercasing mixed-case
    // test/seed keys (e.g. P8-E2E-A-9bef…) made activate return INVALID_LICENSE.
    const key = licenseKey.trim();
    if (!key && !isDesktopPreBaked) {
      setError("الرجاء إدخال مفتاح الترخيص");
      return;
    }
    setLoading(true);
    try {
      const tid = await ensureTenant();
      // Report the real device platform/hostname so the backend records this
      // install correctly on `device_registrations` and can enforce the
      // per-license device cap. Inside Tauri these come from the Rust
      // fingerprint command; on the web they degrade to browser values.
      const device = await getActivationDeviceInfo();
      let r;
      try {
        const body: Record<string, unknown> = {
          tenantId: tid,
          platform: device.platform,
          hostname: device.hostname,
          fingerprint: device.fingerprint,
        };
        if (key) body.key = key;
        r = await apiPost("/api/setup/wizard/activate", body);
      } catch (netErr) {
        throw new Error(
          "تعذّر الاتصال بخادم التفعيل. تحقق من الشبكة ثم أعد المحاولة.",
        );
      }

      if (!r.ok) {
        const code = r.data?.code || r.data?.message || "";
        if (code === "INVALID_LICENSE" || r.status === 400)
          throw new Error(
            typeof r.data?.message === "string" && r.data.message.trim()
              ? r.data.message
              : "مفتاح الترخيص غير صالح",
          );
        if (code === "LICENSE_BOUND_TO_ANOTHER_TENANT" || r.status === 409) {
          throw new Error("المفتاح مُفعّل على تثبيت آخر. استخدم نقل الترخيص أو راجع الدعم");
        }
        throw new Error(
          typeof r.data?.message === "string" && r.data.message.trim()
            ? r.data.message
            : "فشل التفعيل. تحقق من المفتاح ثم أعد المحاولة.",
        );
      }
      const resolvedTenantId = (r.data?.tenantId as string | undefined) || tid;
      if (resolvedTenantId !== tid) {
        setTenantId(resolvedTenantId);
        setInstallTenantId(resolvedTenantId);
      } else {
        setInstallTenantId(resolvedTenantId);
      }
      const activationId = r.data?.activationId ?? r.data?.id ?? resolvedTenantId;
      setPendingActivationId(activationId);

      // Pre-provisioned install (desktop baked or seeded web tenant): backend
      // marks wizard complete on activate — open login, no company/admin forms.
      const skipWizard = isDesktopPreBaked || r.data?.isCompleted === true;
      if (skipWizard) {
        if (isDesktopPreBaked && !r.data?.isCompleted) {
          const cp = await apiPost("/api/setup/wizard/complete", {
            tenantId: resolvedTenantId,
          });
          if (!cp.ok && cp.data?.code !== "ALREADY_COMPLETED") {
            throw new Error(cp.data?.message || "فشل إكمال الإعداد");
          }
        }
        await saveLicenseKey(key || "DESKTOP");
        await saveActivationId(activationId);
        setStep("done");
        onActivated();
        return;
      }

      // Empty DB: license unlocks install → one password screen only.
      const fromLicense =
        (typeof r.data?.companyName === "string" && r.data.companyName.trim()) || "شركتي";
      setCompanyName(fromLicense);
      const co = await apiPost("/api/setup/wizard/company", {
        tenantId: resolvedTenantId,
        name: fromLicense,
      });
      if (!co.ok && co.data?.code !== "ALREADY_COMPLETED") {
        throw new Error(co.data?.message || "فشل تهيئة الشركة من الترخيص");
      }
      await saveLicenseKey(key);
      await saveActivationId(activationId);
      setStep("bootstrap");
    } catch (err) {
      setTenantId("");
      setError(err instanceof Error ? err.message : "حدث خطأ غير متوقع");
    } finally {
      setLoading(false);
    }
  }

  async function submitBootstrap(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (adminPassword.length < 8) {
      setError("كلمة المرور يجب أن تكون 8 أحرف على الأقل");
      return;
    }
    if (adminPassword !== adminPasswordConfirm) {
      setError("كلمتا المرور غير متطابقتين");
      return;
    }
    setLoading(true);
    try {
      const tid = await ensureTenant();
      const admin = await apiPost("/api/setup/wizard/admin", {
        tenantId: tid,
        name: "المدير",
        email: "admin@erp.local",
        password: adminPassword,
      });
      if (!admin.ok) {
        throw new Error(
          admin.data?.message || "فشل حفظ كلمة المرور — تأكد أنها 8 أحرف على الأقل",
        );
      }
      const rv = await apiPost("/api/setup/wizard/review", { tenantId: tid, confirmed: true });
      const reviewAlreadyDone = rv.status === 409 || rv.data?.code === "ALREADY_COMPLETED";
      if (!rv.ok && !reviewAlreadyDone) throw new Error(rv.data?.message || "فشل إكمال الإعداد");
      const cp = await apiPost("/api/setup/wizard/complete", { tenantId: tid });
      if (!cp.ok && !reviewAlreadyDone) throw new Error(cp.data?.message || "فشل إكمال الإعداد");
      setInstallTenantId(tid);
      if (rememberYear) {
        try {
          localStorage.setItem(
            "erp.auth.rememberUntil",
            String(Date.now() + 365 * 24 * 60 * 60 * 1000),
          );
        } catch {
          /* ignore */
        }
      }
      setStep("done");
      onActivated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ غير متوقع");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="min-h-screen w-full bg-background text-foreground flex items-center justify-center px-4"
      dir="rtl"
    >
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-2xl">
        <div className="flex flex-col items-center text-center">
          <img src={logoUrl} alt="أقمشة ومنسوجات" className="h-16 w-16 object-contain object-center" />
          <h1 className="mt-4 text-2xl font-bold tracking-tight text-foreground">إعداد النظام</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {step === "activate" &&
              (isDesktopPreBaked
                ? "تم تضمين الترخيص مسبقاً في هذا التثبيت"
                : "تفعيل الجهاز مرة واحدة — ترخيص أو دعوة")}
            {step === "bootstrap" && "مبروك — تم تفعيل الترخيص"}
            {step === "done" && "تم تفعيل النظام بنجاح"}
          </p>
        </div>

        <DesktopServerSettings />

        {error && (
          <p className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}

        {step === "activate" && !isDesktopPreBaked && (
          <div className="mt-6 space-y-3">
            <p className="text-center text-[11px] text-muted-foreground">
              اختر نوع التفعيل — مساران مختلفان تماماً
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setActivateMode("license");
                  setError(null);
                  setInvError(null);
                }}
                className={cn(
                  "rounded-xl border px-3 py-3 text-start transition",
                  activateMode === "license"
                    ? "border-primary bg-primary/10 ring-2 ring-primary/30"
                    : "border-border bg-secondary/40 hover:border-primary/40",
                )}
              >
                <div className="text-xs font-extrabold text-foreground">مفتاح ترخيص</div>
                <div className="mt-1 text-[10px] leading-snug text-muted-foreground">
                  تفعيل شركة / جهاز جديد (LIC-…)
                </div>
              </button>
              <button
                type="button"
                onClick={() => {
                  setActivateMode("invitation");
                  setError(null);
                  setInvError(null);
                }}
                className={cn(
                  "rounded-xl border px-3 py-3 text-start transition",
                  activateMode === "invitation"
                    ? "border-amber-500 bg-amber-500/10 ring-2 ring-amber-500/30"
                    : "border-border bg-secondary/40 hover:border-amber-500/40",
                )}
              >
                <div className="text-xs font-extrabold text-foreground">رمز دعوة</div>
                <div className="mt-1 text-[10px] leading-snug text-muted-foreground">
                  انضمام لشركة مفعّلة أصلاً
                </div>
              </button>
            </div>

            {activateMode === "license" && (
              <form onSubmit={submitActivate} className="space-y-4 pt-2">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                    مفتاح الترخيص
                  </span>
                  <input
                    type="text"
                    value={licenseKey}
                    onChange={(e) => setLicenseKey(e.target.value)}
                    placeholder="LIC-XXXX-XXXX-XXXX"
                    className="w-full rounded-lg border border-border bg-secondary px-3 py-2.5 text-sm uppercase tracking-wider outline-none focus:border-primary"
                    autoFocus
                  />
                </label>
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full rounded-lg bg-primary px-4 py-3 text-sm font-bold text-primary-foreground disabled:opacity-50"
                >
                  {loading ? "جاري التفعيل…" : "تفعيل الجهاز"}
                </button>
              </form>
            )}

            {activateMode === "invitation" && (
              <form onSubmit={submitInvitation} className="space-y-4 pt-2">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                    رمز الدعوة
                  </span>
                  <input
                    type="text"
                    value={invCode}
                    onChange={(e) => setInvCode(e.target.value)}
                    placeholder="XXXX-XXXX-XXXX"
                    className="w-full rounded-lg border border-border bg-secondary px-3 py-2.5 text-center font-mono text-sm tracking-widest outline-none focus:border-primary"
                    autoFocus
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                    رقم سري شخصي (4 أرقام)
                  </span>
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={4}
                    value={invPassword}
                    onChange={(e) => setInvPassword(e.target.value.replace(/\D/g, "").slice(0, 4))}
                    className="w-full rounded-lg border border-border bg-secondary px-3 py-2.5 text-center text-lg tracking-[0.4em] outline-none focus:border-primary"
                    autoComplete="new-password"
                  />
                </label>
                {invError && (
                  <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {invError}
                  </p>
                )}
                {invSuccess && (
                  <p className="rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs text-primary">
                    {invSuccess}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full rounded-lg bg-amber-500 px-4 py-3 text-sm font-bold text-amber-950 disabled:opacity-50"
                >
                  {loading ? "جاري التفعيل…" : "تفعيل الدعوة والانضمام"}
                </button>
              </form>
            )}
          </div>
        )}

        {step === "activate" && isDesktopPreBaked && (
          <div className="mt-6 space-y-4">
            <p className="rounded-md border border-border bg-secondary px-3 py-3 text-sm text-muted-foreground">
              يتضمّن هذا التثبيت ترخيصاً مفعّلاً مسبقاً. اضغط متابعة لإكمال تفعيل هذا الجهاز مرة
              واحدة.
            </p>
            <button
              type="button"
              onClick={(e) => void submitActivate(e)}
              disabled={loading}
              className="w-full rounded-lg bg-primary px-4 py-3 text-sm font-bold text-primary-foreground disabled:opacity-50"
            >
              {loading ? "جاري التفعيل…" : "متابعة — تفعيل هذا الجهاز"}
            </button>
            <button
              type="button"
              className="w-full text-xs text-amber-700 underline dark:text-amber-400"
              onClick={() => {
                setActivateMode("invitation");
              }}
            >
              أو لديك رمز دعوة للانضمام؟
            </button>
            {activateMode === "invitation" && (
              <form onSubmit={submitInvitation} className="space-y-4 border-t border-border pt-4">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                    رمز الدعوة
                  </span>
                  <input
                    type="text"
                    value={invCode}
                    onChange={(e) => setInvCode(e.target.value)}
                    placeholder="XXXX-XXXX-XXXX"
                    className="w-full rounded-lg border border-border bg-secondary px-3 py-2.5 text-center font-mono text-sm tracking-widest outline-none focus:border-primary"
                  />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-muted-foreground">
                    رقم سري (4 أرقام)
                  </span>
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={4}
                    value={invPassword}
                    onChange={(e) => setInvPassword(e.target.value.replace(/\D/g, "").slice(0, 4))}
                    className="w-full rounded-lg border border-border bg-secondary px-3 py-2.5 text-center text-lg tracking-[0.4em] outline-none focus:border-primary"
                  />
                </label>
                {invError && (
                  <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    {invError}
                  </p>
                )}
                {invSuccess && (
                  <p className="rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs text-primary">
                    {invSuccess}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full rounded-lg bg-amber-500 px-4 py-3 text-sm font-bold text-amber-950 disabled:opacity-50"
                >
                  {loading ? "جاري التفعيل…" : "تفعيل الدعوة"}
                </button>
              </form>
            )}
          </div>
        )}

        {step === "bootstrap" && !isDesktopPreBaked && (
          <form onSubmit={submitBootstrap} className="mt-6 space-y-4">
            <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-3 text-sm text-emerald-700 dark:text-emerald-300">
              مبروك — تم تفعيل الترخيص لـ «{companyName}». عيّن كلمة مرور المدير للمتابعة.
            </p>
            <Field label="كلمة المرور (8 أحرف على الأقل)">
              <input
                type="password"
                className={inputCls}
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                autoComplete="new-password"
                autoFocus
              />
            </Field>
            <Field label="تأكيد كلمة المرور">
              <input
                type="password"
                className={inputCls}
                value={adminPasswordConfirm}
                onChange={(e) => setAdminPasswordConfirm(e.target.value)}
                autoComplete="new-password"
              />
            </Field>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={rememberYear}
                onChange={(e) => setRememberYear(e.target.checked)}
                className="rounded border-border"
              />
              تذكّر هذا الجهاز لمدة سنة
            </label>
            <button type="submit" disabled={loading} className={btnCls}>
              {loading ? "جاري الحفظ…" : "تم — ادخل النظام"}
            </button>
          </form>
        )}

        {step === "done" && (
          <p className="mt-6 text-center text-sm text-foreground">
            تم تفعيل النظام. يمكنك تسجيل الدخول الآن.
          </p>
        )}
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-border bg-secondary px-3 py-2.5 text-sm outline-none focus:border-primary";
const btnCls =
  "w-full rounded-lg bg-primary px-4 py-3 text-sm font-bold text-primary-foreground disabled:opacity-50";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
