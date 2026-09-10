const STORAGE_KEY = "erp.runtime.apiBaseUrl";

function normalize(raw: string | null | undefined, emptyFallback: "" | "/api"): "" | "/api" | string {
  const trimmed = raw?.trim();
  if (!trimmed || trimmed === "/api") return emptyFallback;
  return trimmed.replace(/\/+$/, "");
}

function readRuntimeOverride(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    const normalized = normalize(value, "");
    return normalized === "" ? null : normalized;
  } catch {
    return null;
  }
}

export function getApiBaseUrl(emptyFallback: "" | "/api" = "/api"): "" | "/api" | string {
  const runtime = readRuntimeOverride();
  if (runtime) return runtime;
  const envValue = import.meta.env.VITE_API_BASE_URL as string | undefined;
  return normalize(envValue, emptyFallback);
}

export function getRuntimeApiBaseUrl(): string {
  return readRuntimeOverride() ?? "";
}

export function setRuntimeApiBaseUrl(raw: string): string {
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
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
