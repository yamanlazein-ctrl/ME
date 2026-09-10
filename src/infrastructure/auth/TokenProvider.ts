import type { TokenProvider } from "@/infrastructure/http/types";

const TOKEN_KEY = "erp.auth.accessToken";
const REFRESH_KEY = "erp.auth.refreshToken";

function isDefinitiveAuthFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; statusCode?: number; status?: number };
  if (
    e.code === "UNAUTHORIZED" ||
    e.code === "FORBIDDEN" ||
    e.code === "TOKEN_EXPIRED" ||
    e.code === "INVALID_CREDENTIALS"
  ) {
    return true;
  }
  const status = e.statusCode ?? e.status;
  return status === 401 || status === 403;
}

export function createTokenProvider(): TokenProvider {
  return {
    getToken(): string | null {
      if (typeof window === "undefined") return null;
      try {
        return localStorage.getItem(TOKEN_KEY);
      } catch {
        return null;
      }
    },
    async onTokenExpired(): Promise<string | null> {
      if (typeof window === "undefined") return null;
      try {
        const refreshToken = localStorage.getItem(REFRESH_KEY);
        if (!refreshToken) return null;
        const { container } = await import("@/infrastructure/container");
        const res = await container.auth.repository.refreshToken({
          refreshToken,
        });
        localStorage.setItem(TOKEN_KEY, res.accessToken);
        if (res.refreshToken) localStorage.setItem(REFRESH_KEY, res.refreshToken);
        return res.accessToken;
      } catch (err) {
        // Issue 18: never wipe a long-lived session on transient network/5xx —
        // only clear when the server rejects the refresh token itself.
        if (isDefinitiveAuthFailure(err)) {
          try {
            localStorage.removeItem(TOKEN_KEY);
            localStorage.removeItem(REFRESH_KEY);
          } catch {
            /* ignore */
          }
        }
        return null;
      }
    },
  };
}

export function persistTokens(accessToken: string, refreshToken?: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(TOKEN_KEY, accessToken);
    if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
  } catch {
    /* ignore */
  }
}

export function clearTokens(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
  } catch {
    /* ignore */
  }
}

/** Read the current access token (null when logged out / not in a browser). */
export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Refresh token presence — used to decide if a session should be restored. */
export function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

/** True when either access or refresh token is present locally. */
export function hasStoredSession(): boolean {
  return Boolean(getAccessToken() || getRefreshToken());
}

export function isAuthFailure(err: unknown): boolean {
  return isDefinitiveAuthFailure(err);
}
