import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { container } from "@/infrastructure/container";
import { buildTenantContext } from "@/infrastructure/di/auth-context";

const ctx = buildTenantContext();

const KEYS = {
  all: ["notifications"] as const,
  count: ["notifications", "count"] as const,
};

export function useNotifications() {
  return useQuery({
    queryKey: KEYS.all,
    queryFn: ({ signal }) => {
      void signal;
      return container.notifications.list.execute(ctx);
    },
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}

export function useUnreadCount() {
  return useQuery({
    queryKey: KEYS.count,
    queryFn: ({ signal }) => {
      void signal;
      return container.notifications.list.getUnreadCount(ctx);
    },
    staleTime: 10_000,
  });
}

export function useDismissNotifications() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => container.notifications.list.dismissAll(ctx),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.all });
      qc.invalidateQueries({ queryKey: KEYS.count });
    },
  });
}

export function useCreateNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { title: string; detail?: string; kind?: string; severity?: string; targetPath?: string }) =>
      container.notifications.list.create(input, ctx),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.all });
      qc.invalidateQueries({ queryKey: KEYS.count });
    },
  });
}
