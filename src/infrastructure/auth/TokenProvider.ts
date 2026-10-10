import type { TokenProvider } from "@/infrastructure/http/types";

const TOKEN_KEY = "erp.auth.accessToken";
const REFRESH_KEY = "erp.auth.refreshToken";

/**
 * Field incident (2026-10-09): after a factory reset the WebView kept its stale
 * tokens while the fresh database had a new JWT secret and an incomplete setup
 * wizard. Every refresh was refused (never a 401/403 that would clear the
 * session), some caller kept re-entering this function, and the install logged
 * 13,146 POST /api/auth/refresh in ~113 s while the UI sat on
 * «جاري استعادة الجلسة» forever. Two guards make that state impossible:
 *
 *  1. SINGLE-FLIGHT: concurrent 401s share one refresh instead of racing (a
 *     racing second refresh used to rotate the token twice and trip reuse
 *     detection, destroying a perfectly good session).
 *  2. ATTEMPT CAP: a refresh that keeps failing can only be retried a bounded
 *     number of times per session; past the cap the stored session is dropped,
 *     so the AuthGate lands on the user picker instead of spinning forever.
 *     `persistTokens` (any successful login) resets the counter.
 */
const MAX_REFRESH_ATTEMPTS = 5;
let refreshInFlight: Promise<string | null> | null = null;
let refreshAttempts = 0;
/**
 * Re-entrancy guard (field incident, boot e1579c10): the refresh POST itself
 * goes through the same interceptor chain, so its own 401 re-enters
 * onTokenExpired. Returning the in-flight promise there made the refresh
 * await itself — a circular await that never settled, the UI sat on
 * «جاري استعادة الجلسة» forever and clearTokens was never reached. While the
 * refresh is ON THE WIRE, a nested onTokenExpired must answer null (fail the
 * caller) instead of awaiting its own flight.
 */
let refreshOnWire = false;

/** HTTP status carried by a thrown error, if any. NetworkError reports 0. */
function errorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { statusCode?: number; status?: number };
  return e.statusCode ?? e.status;
}

function isDefinitiveAuthFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: string;
    responseBody?: { code?: string };
  };
  // Only a rejected *credential* ends a session. FORBIDDEN is deliberately
  // absent: the token is still valid, the caller simply lacks the role. It
  // used to be treated as a session end, so the first screen an operator
  // opened that their role cannot manage logged them out of the whole app.
  if (e.code === "UNAUTHORIZED" || e.code === "TOKEN_EXPIRED" || e.code === "INVALID_CREDENTIALS") {
    return true;
  }
  // The http client maps unknown statuses to ApiError(code=API_ERROR) and
  // keeps the server code in the body.
  const bodyCode = e.responseBody?.code;
  if (bodyCode === "TOKEN_EXPIRED" || bodyCode === "UNAUTHORIZED") {
    return true;
  }
  return errorStatus(err) === 401;
}

/**
 * The install gate answers 503 SETUP_REQUIRED for every business route until
 * the setup wizard is done — and also when it cannot read its own state
 * (install.gate.middleware.ts falls through to the same 503 on a DB error).
 * The tokens are not rejected; the app just has nothing to serve. Retrying
 * cannot change that answer, so callers should stop instead of stalling.
 */
export function isSetupRequired(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; responseBody?: { code?: string } };
  return e.code === "SETUP_REQUIRED" || e.responseBody?.code === "SETUP_REQUIRED";
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
      // Single-flight: concurrent 401s share one in-progress refresh. A
      // NESTED call (the refresh request's own 401 passing through the same
      // interceptor) must not await the flight — that is the circular await
      // that deadlocked the cold boot; it answers null and fails the caller.
      if (refreshInFlight) return refreshOnWire ? null : refreshInFlight;
      // Attempt cap: a session that cannot be refreshed must not be retried
      // forever — drop it and let the AuthGate show the user picker.
      if (refreshAttempts >= MAX_REFRESH_ATTEMPTS) {
        try {
          localStorage.removeItem(TOKEN_KEY);
          localStorage.removeItem(REFRESH_KEY);
        } catch {
          /* ignore */
        }
        return null;
      }
      refreshAttempts += 1;
      refreshOnWire = true;
      refreshInFlight = (async (): Promise<string | null> => {
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
          // Issue 18: only a server *rejection* of the refresh token ends the
          // session. Everything else keeps both tokens so the next request can
          // retry — NetworkError (status 0), 5xx, and the 503 SETUP_REQUIRED
          // the install gate returns before the wizard is done.
          const status = errorStatus(err);
          if (status === 401 || status === 403) {
            try {
              localStorage.removeItem(TOKEN_KEY);
              localStorage.removeItem(REFRESH_KEY);
            } catch {
              /* ignore */
            }
          }
          return null;
        } finally {
          refreshOnWire = false;
          refreshInFlight = null;
        }
      })();
      return refreshInFlight;
    },
  };
}

/** Fired when a NEW session starts (no access token before) — any login path. */
export const SESSION_STARTED_EVENT = "erp:session-started";

/** Fired when the stored session goes away — explicit logout or a rejected refresh. */
export const SESSION_ENDED_EVENT = "erp:session-ended";

export function persistTokens(accessToken: string, refreshToken?: string): void {
  if (typeof window === "undefined") return;
  // A successful login is a working session — give the refresh cap a fresh budget.
  refreshAttempts = 0;
  refreshInFlight = null;
  let hadSession = false;
  try {
    hadSession = !!localStorage.getItem(TOKEN_KEY);
    localStorage.setItem(TOKEN_KEY, accessToken);
    if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
  } catch {
    /* ignore */
  }
  // Module caches (customers/suppliers, fabrics/colors/rolls) load once at
  // startup and only when a token already exists. A login that happens AFTER
  // startup (PIN picker, invite, PIN recovery, first run after activation)
  // left them empty: every customer, supplier and roll "disappeared" while
  // the dashboard — which queries directly — still showed the figures.
  // Token refreshes (a session already existed) do not reload them.
  if (!hadSession) {
    try {
      window.dispatchEvent(new Event(SESSION_STARTED_EVENT));
    } catch {
      /* ignore */
    }
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
  try {
    window.dispatchEvent(new Event(SESSION_ENDED_EVENT));
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

/**
 * True when the caller is authenticated but not allowed. Not a session end —
 * but never worth a retry either, so it is reported separately.
 */
export function isPermissionDenied(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; responseBody?: { code?: string } };
  if (e.code === "FORBIDDEN" || e.responseBody?.code === "FORBIDDEN") return true;
  return errorStatus(err) === 403;
}
