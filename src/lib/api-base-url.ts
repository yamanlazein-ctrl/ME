const STORAGE_KEY = "erp.runtime.apiBaseUrl";
function isDesktopDeploy(): boolean {
  return import.meta.env.VITE_DESKTOP_DEPLOY === "true";
}

function normalize(raw: string | null | undefined, emptyFallback: "" | "/api"): "" | "/api" | string {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "/api") return emptyFallback;
  return trimmed.replace(/\/+$/, "");
}

function readRuntimeOverride(): string | null {
  if (isDesktopDeploy()) return null;
  if (typeof window === "undefined") return null;
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    const normalized = normalize(value, "");
    return normalized === "" ? null : normalized;
  } catch {
    return null;
  }
}

export function getApiBaseUrl(emptyFallback: "" | "/api" = ""): "" | "/api" | string {
  if (isDesktopDeploy()) {
    const envValue = import.meta.env.VITE_API_BASE_URL as string | undefined;
    const fromEnv = normalize(envValue, emptyFallback);
    if (fromEnv && fromEnv !== "/api" && fromEnv !== "") return fromEnv;
    return "http://127.0.0.1:8080";
  }
  const runtime = readRuntimeOverride();
  if (runtime) return runtime;
  const envValue = import.meta.env.VITE_API_BASE_URL as string | undefined;
  return normalize(envValue, emptyFallback);
}

export function getRuntimeApiBaseUrl(): string {
  if (isDesktopDeploy()) return "";
  return readRuntimeOverride() ?? "";
}

export function setRuntimeApiBaseUrl(raw: string): string {
  if (isDesktopDeploy()) return "";
  const normalized = normalize(raw, "");
  if (typeof window !== "undefined") {
    try {
      if (normalized === "") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, normalized);
    } catch {
      // Ignore storage failures; caller still gets the normalized value.
    }
  }
  return normalized;
}

export function clearRuntimeApiBaseUrl(): void {
  if (isDesktopDeploy()) return;
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
