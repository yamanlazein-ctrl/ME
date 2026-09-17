import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { container } from "@/infrastructure/container";
import type { SyncConflictDecision } from "@/infrastructure/api/SyncConflictsApiService";

const KEYS = {
  all: ["sync-conflicts"] as const,
  open: ["sync-conflicts", "open"] as const,
};

export function useOpenSyncConflicts() {
  return useQuery({
    queryKey: KEYS.open,
    queryFn: () => container.syncConflicts.api.list(false),
    staleTime: 8_000,
    refetchInterval: 20_000,
  });
}

export function useOpenSyncConflictCount() {
  const q = useOpenSyncConflicts();
  return q.data?.length ?? 0;
}

export function useResolveSyncConflict() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { conflictId: string; decision: SyncConflictDecision; note?: string }) =>
      container.syncConflicts.api.resolve(input.conflictId, input.decision, input.note),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEYS.all });
    },
  });
}
