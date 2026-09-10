import { useState } from "react";
import {
  clearRuntimeApiBaseUrl,
  getRuntimeApiBaseUrl,
  setRuntimeApiBaseUrl,
} from "@/lib/api-base-url";

const ENV_BASE = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "").trim();
const IS_DESKTOP = import.meta.env.VITE_DESKTOP_DEPLOY === "true";

export function DesktopServerSettings() {
  const [value, setValue] = useState(() => getRuntimeApiBaseUrl());
  const [saved, setSaved] = useState<string | null>(null);

  if (!IS_DESKTOP) return null;

  const envLabel = !ENV_BASE || ENV_BASE === "/api" ? "المحلي الافتراضي" : ENV_BASE;

  return (
    <div className="mt-6 rounded-xl border border-border bg-secondary/40 p-4 text-right">
      <div className="text-sm font-semibold text-foreground">خادم المزامنة</div>
      <p className="mt-1 text-xs leading-6 text-muted-foreground">
        اتركه فارغاً لاستخدام الخادم المحلي المدمج، أو أدخل رابط الخادم المركزي مثل
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
        placeholder={ENV_BASE && ENV_BASE !== "/api" ? ENV_BASE : "https://erp.example.com"}
        className="mt-3 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
      />
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={() => {
            const normalized = setRuntimeApiBaseUrl(value);
            setValue(normalized);
            setSaved(normalized ? "تم حفظ رابط الخادم." : "تمت العودة إلى الخادم المحلي المدمج.");
          }}
          className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground"
        >
          حفظ
        </button>
        <button
          type="button"
          onClick={() => {
            clearRuntimeApiBaseUrl();
            setValue("");
            setSaved("تمت العودة إلى الخادم المحلي المدمج.");
          }}
          className="rounded-lg border border-border px-3 py-2 text-xs"
        >
          استخدام المحلي
        </button>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">الافتراضي الحالي: {envLabel}</p>
      {saved && <p className="mt-2 text-[11px] text-primary">{saved}</p>}
    </div>
  );
}
