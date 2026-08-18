import type { TokenProvider } from "@/infrastructure/http/types";

const TOKEN_KEY = "erp.auth.accessToken";
const REFRESH_KEY = "erp.auth.refreshToken";

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
        if (res.refreshToken)
          localStorage.setItem(REFRESH_KEY, res.refreshToken);
        return res.accessToken;
      } catch {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(REFRESH_KEY);
        return null;
      }
    },
  };
}

export function persistTokens(
  accessToken: string,
  refreshToken?: string,
): void {
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
