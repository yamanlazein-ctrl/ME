import { useState } from "react";
import logoUrl from "@/assets/logo-mo-clean.png";
import {
  setActivationId as saveActivationId,
  setLicenseKey as saveLicenseKey,
} from "@/lib/license-state";

/**
 * R3 — full Setup Wizard for the customer ERP frontend.
 *
 * Drives the backend setup flow end-to-end so that a real Owner user is
 * created (completeWizardUseCase → R1) and the customer can subsequently
 * log in. Replaces the old standalone activation screen that only talked
 * to the License Server's /v1/activations (which 404s on the customer
 * backend).
 *
 * Steps: init → activate → company → admin → review → done.
 */
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "";
const SETUP_TOKEN = import.meta.env.VITE_SETUP_TOKEN as string | undefined;

type Step = "activate" | "company" | "admin" | "review" | "done";

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (SETUP_TOKEN) h["X-Setup-Token"] = SETUP_TOKEN;
  return h;
}

async function apiPost(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: any }> {
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
  const [tenantId, setTenantId] = useState<string>("");
  const [licenseKey, setLicenseKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Company
  const [companyName, setCompanyName] = useState("");
  const [companyEmail, setCompanyEmail] = useState("");
  const [companyPhone, setCompanyPhone] = useState("");
  // Admin
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");

  async function ensureTenant(): Promise<string> {
    if (tenantId) return tenantId;
    const r = await apiPost("/api/setup/init", {});
    if (!r.ok) throw new Error("تعذّر تهيئة التثبيت");
    const id = r.data?.tenantId ?? r.data?.id;
    if (!id) throw new Error("استجابة غير صالحة من الخادم");
    setTenantId(id);
    return id;
  }

  async function submitActivate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const key = licenseKey.trim().toUpperCase();
    if (!key) {
      setError("الرجاء إدخال مفتاح الترخيص");
      return;
    }
    setLoading(true);
    try {
      const tid = await ensureTenant();
       let r;
       try {
         r = await apiPost("/api/setup/wizard/activate", { tenantId: tid, key });
       } catch (netErr) {
         throw new Error("خطأ شبكة: " + (netErr instanceof Error ? netErr.message : "فشل الاتصال") + " | tenantId=" + tid + " | key=" + key);
       }

       if (!r.ok) {
         const code = r.data?.code || r.data?.message || "";
         if (code === "INVALID_LICENSE" || r.status === 400) throw new Error("فشل التفعيل (400): " + (r.data?.message || code || "رسالة فارغة") + " | tenantId=" + tid);
         if (code === "LICENSE_BOUND_TO_ANOTHER_TENANT" || r.status === 409) {
           throw new Error("المفتاح مُفعّل على تثبيت آخر. استخدم نقل الترخيص أو راجع الدعم");
         }
         throw new Error("فشل التفعيل (status " + r.status + "): " + (typeof r.data?.message === "string" ? r.data.message : "رسالة غير معروفة") + " | data=" + JSON.stringify(r.data));
       }
      saveLicenseKey(key);
      saveActivationId(r.data?.activationId ?? r.data?.id ?? tid);
      setStep("company");
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ غير متوقع");
    } finally {
      setLoading(false);
    }
  }

  async function submitCompany(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!companyName.trim()) {
      setError("الرجاء إدخال اسم الشركة");
      return;
    }
    setLoading(true);
    try {
      const tid = await ensureTenant();
      const r = await apiPost("/api/setup/wizard/company", {
        tenantId: tid,
        name: companyName,
        email: companyEmail || null,
        phone: companyPhone || null,
      });
      if (!r.ok) throw new Error(r.data?.message || "فشل حفظ بيانات الشركة");
      setStep("admin");
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ غير متوقع");
    } finally {
      setLoading(false);
    }
  }

  async function submitAdmin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!adminName.trim() || !adminEmail.trim() || !adminPassword) {
      setError("الرجاء إدخال بيانات المدير بشكل كامل");
      return;
    }
    setLoading(true);
    try {
      const tid = await ensureTenant();
      const r = await apiPost("/api/setup/wizard/admin", {
        tenantId: tid,
        name: adminName,
        email: adminEmail,
        password: adminPassword,
      });
      if (!r.ok) throw new Error(r.data?.message || "فشل حفظ حساب المدير");
      setStep("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ غير متوقع");
    } finally {
      setLoading(false);
    }
  }

  async function submitReview(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const tid = await ensureTenant();
      const rv = await apiPost("/api/setup/wizard/review", { tenantId: tid, confirmed: true });
      if (!rv.ok) throw new Error(rv.data?.message || "فشل المراجعة");
      const cp = await apiPost(`/api/setup/wizard/complete?tenantId=${encodeURIComponent(tid)}`, {});
      if (!cp.ok) throw new Error(cp.data?.message || "فشل إكمال الإعداد");
      setStep("done");
      onActivated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ غير متوقع");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen w-full bg-background text-foreground flex items-center justify-center px-4" dir="rtl">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-2xl">
        <div className="flex flex-col items-center text-center">
          <img src={logoUrl} alt="Motard Fabrics Group" className="h-20 w-auto object-contain" />
          <h1 className="mt-4 text-2xl font-bold tracking-tight text-foreground">إعداد النظام</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {step === "activate" && "أدخل مفتاح الترخيص لبدء التفعيل"}
            {step === "company" && "بيانات الشركة"}
            {step === "admin" && "حساب المدير الرئيسي"}
            {step === "review" && "مراجعة وإكمال"}
            {step === "done" && "تم تفعيل النظام بنجاح"}
          </p>
        </div>

        {error && (
          <p className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}

        {step === "activate" && (
          <form onSubmit={submitActivate} className="mt-6 space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">مفتاح الترخيص</span>
              <input
                type="text"
                value={licenseKey}
                onChange={(e) => setLicenseKey(e.target.value)}
                placeholder="MF-XXX-XXXX-XXXX-XXXX"
                className="w-full rounded-lg border border-border bg-secondary px-3 py-2.5 text-sm uppercase tracking-wider outline-none focus:border-primary"
                autoFocus
              />
            </label>
            <button type="submit" disabled={loading} className="w-full rounded-lg bg-primary px-4 py-3 text-sm font-bold text-primary-foreground disabled:opacity-50">
              {loading ? "جاري التفعيل…" : "تفعيل"}
            </button>
          </form>
        )}

        {step === "company" && (
          <form onSubmit={submitCompany} className="mt-6 space-y-4">
            <Field label="اسم الشركة"><input className={inputCls} value={companyName} onChange={(e) => setCompanyName(e.target.value)} /></Field>
            <Field label="البريد الإلكتروني"><input className={inputCls} value={companyEmail} onChange={(e) => setCompanyEmail(e.target.value)} /></Field>
            <Field label="الهاتف"><input className={inputCls} value={companyPhone} onChange={(e) => setCompanyPhone(e.target.value)} /></Field>
            <button type="submit" disabled={loading} className={btnCls}>{loading ? "جاري الحفظ…" : "التالي"}</button>
          </form>
        )}

        {step === "admin" && (
          <form onSubmit={submitAdmin} className="mt-6 space-y-4">
            <Field label="الاسم الكامل"><input className={inputCls} value={adminName} onChange={(e) => setAdminName(e.target.value)} /></Field>
            <Field label="البريد الإلكتروني"><input className={inputCls} value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} /></Field>
            <Field label="كلمة المرور"><input type="password" className={inputCls} value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} /></Field>
            <button type="submit" disabled={loading} className={btnCls}>{loading ? "جاري الحفظ…" : "التالي"}</button>
          </form>
        )}

        {step === "review" && (
          <form onSubmit={submitReview} className="mt-6 space-y-4">
            <ul className="space-y-1 text-xs text-muted-foreground">
              <li>الشركة: {companyName}</li>
              <li>المدير: {adminName} ({adminEmail})</li>
              <li>الترخيص: {licenseKey}</li>
            </ul>
            <button type="submit" disabled={loading} className={btnCls}>{loading ? "جاري الإكمال…" : "إكمال الإعداد"}</button>
          </form>
        )}

        {step === "done" && (
          <p className="mt-6 text-center text-sm text-foreground">تم تفعيل النظام. يمكنك تسجيل الدخول الآن.</p>
        )}
      </div>
    </div>
  );
}

const inputCls = "w-full rounded-lg border border-border bg-secondary px-3 py-2.5 text-sm outline-none focus:border-primary";
const btnCls = "w-full rounded-lg bg-primary px-4 py-3 text-sm font-bold text-primary-foreground disabled:opacity-50";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
