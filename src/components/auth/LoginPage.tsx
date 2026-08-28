import { useState, type FormEvent, type ReactNode } from "react";
import logoUrl from "@/assets/logo-motard.png";
import { useLogin } from "@/presentation/hooks/useAuth";
import { validateInvitation, consumeInvitation } from "@/lib/invitations";
import { getServerFingerprint } from "@/lib/license-state";

export function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Phase ج — invitation entry (an employee redeems a code minted by admin).
  const [mode, setMode] = useState<"login" | "invitation">("login");
  const [invCode, setInvCode] = useState("");
  const [invPassword, setInvPassword] = useState("");
  const [invError, setInvError] = useState<string | null>(null);
  const [invSuccess, setInvSuccess] = useState<string | null>(null);
  const [invPending, setInvPending] = useState(false);

  const loginMutation = useLogin();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    try {
      const tenantId =
        (import.meta.env.VITE_DEFAULT_TENANT_ID as string | undefined) ??
        "dev-tenant";
      await loginMutation.mutateAsync({
        email: username.trim(),
        password,
        tenantId,
      });
    } catch (err) {
      console.error("[Login] Error:", err);
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "اسم المستخدم أو كلمة المرور غير صحيحة.";
      setError(msg);
    }
  };

  const submitInvitation = async (e: FormEvent) => {
    e.preventDefault();
    setInvError(null);
    setInvSuccess(null);
    const code = invCode.trim().toUpperCase();
    if (!code) {
      setInvError("الرجاء إدخال رمز الدعوة");
      return;
    }
    if (invPassword.length < 8) {
      setInvError("كلمة المرور يجب ألا تقل عن 8 أحرف");
      return;
    }
    setInvPending(true);
    try {
      // 1) Validate the code is still usable.
      const v = await validateInvitation(code);
      if (!v.valid) {
        setInvError("رمز الدعوة غير صالح أو منتهٍ");
        return;
      }
      // 2) Consume it. For a user invitation this creates the account and —
      //    via the device fingerprint — consumes a device slot on the license.
      const fingerprint = await getServerFingerprint().catch(() => undefined);
      await consumeInvitation({
        code,
        password: v.type === "user" ? invPassword : undefined,
        deviceFingerprint: fingerprint,
      });
      setInvSuccess("تم إنشاء حسابك بنجاح. سجّل الدخول الآن ببريدك وكلمة المرور.");
      setInvCode("");
      setInvPassword("");
      setTimeout(() => setMode("login"), 1500);
    } catch (err) {
      setInvError(err instanceof Error ? err.message : "فشل تفعيل رمز الدعوة");
    } finally {
      setInvPending(false);
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
            className="h-24 w-auto object-contain bg-transparent"
            style={{ background: "transparent" }}
          />
          <h1 className="mt-4 text-2xl font-bold tracking-tight text-foreground">
            Motard Fabrics Group
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">نظام إدارة تجارة الأقمشة المتكامل</p>
        </div>

        {mode === "login" ? (
          <form onSubmit={submit} className="mt-6 space-y-4">
            <Field label="البريد الإلكتروني">
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full rounded-lg border border-border bg-secondary px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary transition"
                autoComplete="username"
                placeholder="admin@erp.local"
              />
            </Field>
            <Field label="كلمة المرور">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-lg border border-border bg-secondary px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary transition"
                autoComplete="current-password"
              />
            </Field>

            {error && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loginMutation.isPending}
              className="w-full rounded-lg bg-primary px-4 py-3 text-sm font-bold text-primary-foreground hover:brightness-110 transition shadow-lg disabled:opacity-60"
            >
              {loginMutation.isPending ? "جاري تسجيل الدخول..." : "تسجيل الدخول"}
            </button>
          </form>
        ) : (
          <form onSubmit={submitInvitation} className="mt-6 space-y-4">
            <Field label="رمز الدعوة">
              <input
                type="text"
                value={invCode}
                onChange={(e) => setInvCode(e.target.value)}
                className="w-full rounded-lg border border-border bg-secondary px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary transition text-center font-mono tracking-widest"
                placeholder="XXXX-XXXX-XXXX"
              />
            </Field>
            <Field label="كلمة مرور جديدة (8 أحرف على الأقل)">
              <input
                type="password"
                value={invPassword}
                onChange={(e) => setInvPassword(e.target.value)}
                className="w-full rounded-lg border border-border bg-secondary px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary transition"
                autoComplete="new-password"
              />
            </Field>

            {invError && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {invError}
              </p>
            )}
            {invSuccess && (
              <p className="rounded-md border border-success/40 bg-success/10 px-3 py-2 text-xs text-success">
                {invSuccess}
              </p>
            )}

            <button
              type="submit"
              disabled={invPending}
              className="w-full rounded-lg bg-primary px-4 py-3 text-sm font-bold text-primary-foreground hover:brightness-110 transition shadow-lg disabled:opacity-60"
            >
              {invPending ? "جاري التفعيل..." : "تفعيل رمز الدعوة"}
            </button>
          </form>
        )}

        <button
          type="button"
          onClick={() => {
            setMode(mode === "login" ? "invitation" : "login");
            setError(null);
            setInvError(null);
            setInvSuccess(null);
          }}
          className="mt-4 w-full text-center text-xs text-primary hover:underline"
        >
          {mode === "login" ? "لديك رمز دعوة؟ فعّله من هنا" : "العودة إلى تسجيل الدخول"}
        </button>

        <p className="mt-6 text-center text-[10px] text-muted-foreground">
          © 2026 Motard Fabrics Group — جميع الحقوق محفوظة
        </p>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
