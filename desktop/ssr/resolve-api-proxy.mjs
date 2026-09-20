/**
 * Resolve the desktop API base URL for SSR proxying.
 * Prefer SSR_API_PROXY (injected by Rust boot), then AppData runtime-config.json,
 * then the 8080 dev default.
 */
import { existsSync, readFileSync } from "node:fs";

export const DEV_DEFAULT_API = "http://127.0.0.1:8080";

/**
 * @param {string | undefined} path
 * @returns {{ apiBaseUrl: string, backendPort: number } | null}
 */
export function readRuntimeConfig(path) {
  if (!path || !existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const port = Number(raw.backendPort);
    const api =
      typeof raw.apiBaseUrl === "string" && raw.apiBaseUrl.trim()
        ? raw.apiBaseUrl.trim().replace(/\/+$/, "")
        : Number.isFinite(port) && port > 0
          ? `http://127.0.0.1:${port}`
          : null;
    if (!api) return null;
    return {
      apiBaseUrl: api,
      backendPort: Number.isFinite(port) && port > 0 ? port : Number(new URL(api).port) || 8080,
    };
  } catch {
    return null;
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveApiProxy(env = process.env) {
  const fromEnv = env.SSR_API_PROXY?.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  const fromFile = readRuntimeConfig(env.RUNTIME_CONFIG_PATH);
  if (fromFile?.apiBaseUrl) return fromFile.apiBaseUrl;
  return DEV_DEFAULT_API;
}
