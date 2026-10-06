import { useQuery } from "@tanstack/react-query";
import { hubSync, type HubState } from "@/lib/sync-engine";

/** Shared by the settings page and the shell bar so both poll the same cache. */
export const SYNC_HUB_KEY = ["sync", "hub"] as const;

/** 10s — fast enough to show a backlog draining, cheap enough to leave running. */
const HUB_POLL_MS = 10_000;

export function useSyncStatus() {
  return useQuery<HubState>({
    queryKey: SYNC_HUB_KEY,
    queryFn: () => hubSync.state(),
    refetchInterval: HUB_POLL_MS,
  });
}
