import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getApp } from "../core/appRuntime";
import { logError } from "../core/devlog";
import { readAppState, updateAppState, withRecentParty } from "../core/appState";
import { searchParties, sortByRecent, type PartyRow } from "../core/partyQueries";
import { queryKeys } from "./queryKeys";

export function useParties(q: string, kind: "customer" | "supplier" | "") {
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    readAppState()
      .then((s) => setRecent(s.recentPartyIds))
      .catch((e) => logError("recent-parties", e));
  }, []);
  const query = useQuery({
    queryKey: [...queryKeys.parties, q, kind],
    queryFn: async (): Promise<PartyRow[]> => {
      const app = await getApp();
      if (!app.phone) return [];
      return searchParties(app.phone, { q, kind });
    },
  });
  return { ...query, data: query.data ? sortByRecent(query.data, recent) : [] };
}

/** Remembers a party the user opened (FR-11): most recent first, at most 50. */
export function useRememberParty() {
  const qc = useQueryClient();
  return async (partyId: string) => {
    await updateAppState(withRecentParty(await readAppState(), partyId));
    void qc.invalidateQueries({ queryKey: queryKeys.parties });
  };
}
