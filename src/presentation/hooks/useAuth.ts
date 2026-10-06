import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { container } from "@/infrastructure/container";
import { buildTenantContext } from "@/infrastructure/di/auth-context";
import {
  persistTokens,
  clearTokens,
  getAccessToken,
  createTokenProvider,
  hasStoredSession,
  isAuthFailure,
  isSetupRequired,
} from "@/infrastructure/auth/TokenProvider";
import { refreshParties } from "@/presentation/hooks/useParties";
import { refreshInventory } from "@/presentation/hooks/useInventory";
import { setRememberedEmail } from "@/lib/license-state";
import { registerCurrentSyncDevice } from "@/lib/sync-device";
import type { LoginInput } from "@/application/ports/IAuthRepository";
const KEYS = {
  me: ["auth", "me"] as const,
};

// Module-level caches (useParties/useInventory) are primed at import time —
// before the token exists, so they can fill empty during login. Prime them
// again (force) whenever the session is (re)established.
function primeModuleCaches() {
  void refreshParties();
  void refreshInventory();
}

export function useCurrentUser() {
  return useQuery({
    queryKey: KEYS.me,
    queryFn: async () => {
      // Issue 18: cold open often has only a refresh token (access expired).
      // Refresh first so /me does not race a 401 wipe path.
      if (!getAccessToken() && hasStoredSession()) {
        await createTokenProvider().onTokenExpired?.();
      }
      try {
        return await container.auth.repository.getCurrentUser(buildTenantContext());
      } catch (err) {
        // After a DB wipe / setup reset, /me answers 503 SETUP_REQUIRED while
        // stale tokens remain. The tokens are not rejected, so they stay —
        // AuthGate leaves "استعادة الجلسة" on !user either way, and the picker
        // is where the operator belongs after a wipe.
        if (isAuthFailure(err)) clearTokens();
        throw err;
      }
    },
    staleTime: 60_000,
    // Retry transient failures while a session is stored; never retry hard auth fails.
    retry: (count, err) => {
      if (isAuthFailure(err)) return false;
      // Retrying cannot flip a SETUP_REQUIRED, and with a stored session it
      // would stall the cold start for ~10s of backoff before the picker.
      if (isSetupRequired(err)) return false;
      if (!hasStoredSession()) return false;
      return count < 4;
    },
    retryDelay: (i) => Math.min(800 * 2 ** i, 5_000),
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: LoginInput) => {
      const res = await container.auth.repository.login(input);
      persistTokens(res.accessToken, res.refreshToken);
      await registerCurrentSyncDevice().catch((err) => {
        console.warn("[sync-device] registration skipped:", err);
      });
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.me });
      primeModuleCaches();
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      // Issue 18: keep email for password-only re-login after explicit logout.
      const cached = qc.getQueryData<{ email?: string }>(KEYS.me);
      if (cached?.email) setRememberedEmail(cached.email);
      try {
        await container.auth.repository.logout(buildTenantContext());
      } catch {
        /* still clear local tokens */
      }
      clearTokens();
    },
    onSuccess: () => {
      qc.setQueryData(KEYS.me, null);
      qc.clear();
    },
  });
}
