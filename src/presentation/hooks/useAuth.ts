import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { container } from "@/infrastructure/container";
import { buildTenantContext } from "@/infrastructure/di/auth-context";
import { persistTokens, clearTokens } from "@/infrastructure/auth/TokenProvider";
import { refreshParties } from "@/presentation/hooks/useParties";
import { refreshInventory } from "@/presentation/hooks/useInventory";
import type { LoginInput } from "@/application/ports/IAuthRepository";

const ctx = buildTenantContext();

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
    queryFn: ({ signal }) => container.auth.repository.getCurrentUser(ctx),
    staleTime: 60_000,
    retry: false,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: LoginInput) => {
      const res = await container.auth.repository.login(input);
      persistTokens(res.accessToken, res.refreshToken);
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
      await container.auth.repository.logout(ctx);
      clearTokens();
    },
    onSuccess: () => {
      qc.setQueryData(KEYS.me, null);
      qc.clear();
    },
  });
}
