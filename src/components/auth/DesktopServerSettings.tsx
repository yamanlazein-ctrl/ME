import { useEffect, useState } from "react";
import { getApiBaseUrl } from "@/lib/api-base-url";
import { getHubUrl, isTauri, setHubUrl } from "@/infrastructure/tauri-bridge";

const IS_DESKTOP = import.meta.env.VITE_DESKTOP_DEPLOY === "true";

function localApi(): string {
  const base = getApiBaseUrl();
  if (!base || base === "/api") return "http://127.0.0.1:8080";
  return base;
}

export function DesktopServerSettings() {
  const [value, setValue] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!IS_DESKTOP) return;
    void (async () => {
      if (isTauri()) {
        const fromTauri = await getHubUrl().catch(() => "");
        if (fromTauri) {
          setValue(fromTauri);
          return;
        }
      }
      try {
        const res = await fetch(`${localApi()}/api/sync/desktop-hub`);
        if (res.ok) {
          const json = (await res.json()) as { url?: string | null };
          if (json.url) setValue(json.url);
        }
      } catch {
        /* local backend may still be starting */
      }
    })();
  }, []);

  if (!IS_DESKTOP) return null;

  async function persistHub(url: string): Promise<string> {
    let normalized = url.trim().replace(/\/+$/, "");
    if (isTauri()) {
      normalized = await setHubUrl(normalized);
    }
    await fetch(`${localApi()}/api/sync/desktop-hub`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: normalized || null }),
    });
    return normalized;
  }

  return (
    <div className="mt-6 rounded-xl border border-border bg-secondary/40 p-4 text-right">
      <div className="text-sm font-semibold text-foreground">خادم المزامنة</div>
      <p className="mt-1 text-xs leading-6 text-muted-foreground">
        الواجهة تبقى على الخادم المحلي المدمج. هذا الرابط للمركز فقط (صندوق الصادر)، مثل
        <span className="mx-1 font-mono text-[11px]">https://erp.example.com</span>
      </p>
      <input
        dir="ltr"
        type="url"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setSaved(null);
        }}
        placeholder="https://erp.example.com"
        className="mt-3 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
      />
      <input
        dir="ltr"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="بريد حساب المركز"
        className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
      />
      <input
        dir="ltr"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="كلمة سر حساب المركز"
        className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
      />
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void (async () => {
              setBusy(true);
              try {
                const normalized = await persistHub(value);
                setValue(normalized);
                if (normalized && email && password) {
                  const res = await fetch(`${localApi()}/api/sync/desktop-hub-pair`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ url: normalized, email, password }),
                  });
                  const json = (await res.json().catch(() => ({}))) as { message?: string };
                  if (!res.ok) {
                    setSaved(json.message || "تم حفظ الرابط لكن فشل ربط الجلسة بالمركز.");
                    return;
                  }
                  setSaved("تم حفظ رابط المركز وربطه بجلسة مصادقة.");
                  return;
                }
                setSaved(
                  normalized
                    ? "تم حفظ رابط المركز. أدخل حساب المركز لربط الجلسة."
                    : "أُلغي ربط المركز — العمل يبقى محلياً.",
                );
              } catch {
                setSaved("تعذّر حفظ رابط المركز.");
              } finally {
                setBusy(false);
              }
            })();
          }}
          className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground"
        >
          حفظ وربط
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void (async () => {
              setBusy(true);
              try {
                await persistHub("");
                setValue("");
                setSaved("أُلغي ربط المركز — العمل يبقى محلياً.");
              } finally {
                setBusy(false);
              }
            })();
          }}
          className="rounded-lg border border-border px-3 py-2 text-xs"
        >
          بدون مركز
        </button>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        واجهة العمل: {localApi()} (محلي دائماً)
      </p>
      {saved && <p className="mt-2 text-[11px] text-primary">{saved}</p>}
    </div>
  );
}
