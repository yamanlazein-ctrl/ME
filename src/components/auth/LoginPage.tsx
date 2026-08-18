import { useState, type FormEvent, type ReactNode } from "react";
import logoUrl from "@/assets/logo-motard.png";
import { useLogin } from "@/presentation/hooks/useAuth";

export function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loginMutation = useLogin();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    try {
      await loginMutation.mutateAsync({
        email: username.trim(),
        password,
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

  return (
    <div
      className="min-h-screen w-full bg-background text-foreground flex items-center justify-center px-4"
      dir="rtl"
    >
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-2xl">
        <div className="flex flex-col items-center text-center">
          <img src={logoUrl} alt="Motard Fabrics Group" className="h-24 w-auto object-contain bg-transparent" style={{ background: "transparent" }} />
          <h1 className="mt-4 text-2xl font-bold tracking-tight text-foreground">
            Motard Fabrics Group
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">نظام إدارة تجارة الأقمشة المتكامل</p>
        </div>

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
