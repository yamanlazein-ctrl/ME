import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getApp } from "../core/appRuntime";
import { logError } from "../core/devlog";
import { readAppState, updateAppState, withRecentParty } from "../core/appState";
import { sortByRecent } from "../core/partyQueries";
import {
  listParties,
  loadPartyProfile,
  loadStatement,
  partyBalances,
  partyDocuments,
  type CurrencyBalance,
  type PartyDocKind,
  type PartyKind,
  type PartyListRow,
  type StatementQuery,
} from "../core/parties";
import { queryKeys } from "./queryKeys";

/** Remembers a party the user opened (FR-11): most recent first, at most 50. */
export function useRememberParty() {
  const qc = useQueryClient();
  return async (partyId: string) => {
    await updateAppState(withRecentParty(await readAppState(), partyId));
    void qc.invalidateQueries({ queryKey: queryKeys.parties });
  };
}

async function phone() {
  const app = await getApp();
  if (!app.phone) throw new Error("الجهاز غير مسجّل");
  return app.phone;
}

/** The party list: name, code or phone search; the most recently opened first. */
export function usePartyList(q: string, kind: PartyKind | "") {
  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    readAppState()
      .then((s) => setRecent(s.recentPartyIds))
      .catch((e) => logError("recent-parties", e));
  }, []);
  const query = useQuery({
    queryKey: [...queryKeys.parties, "list", q, kind],
    queryFn: async () => listParties(await phone(), { q, kind }),
    placeholderData: (previous) => previous,
  });
  return { ...query, data: query.data ? sortByRecent(query.data, recent) : undefined };
}

/** Balances per currency for the listed parties (one statement-totals read each, like the desktop's party page). */
export function usePartyListBalances(rows: PartyListRow[] | undefined) {
  const ids = (rows ?? []).map((r) => `${r.id}:${r.kind}`);
  return useQuery({
    queryKey: [...queryKeys.parties, "balances", ids.join(",")],
    enabled: ids.length > 0,
    queryFn: async () => {
      const p = await phone();
      const out: Record<string, CurrencyBalance[]> = {};
      for (const r of rows ?? []) out[r.id] = await partyBalances(p, r.id, r.kind);
      return out;
    },
    placeholderData: (previous) => previous,
  });
}

export function usePartyProfile(id: string) {
  return useQuery({
    queryKey: queryKeys.party(id),
    queryFn: async () => loadPartyProfile(await phone(), id),
  });
}

export function usePartyDocuments(id: string, kind: PartyDocKind) {
  return useQuery({
    queryKey: [...queryKeys.party(id), "docs", kind],
    queryFn: async () => partyDocuments(await phone(), id, kind),
  });
}

export function usePartyStatement(q: StatementQuery | null) {
  return useQuery({
    queryKey: [...queryKeys.statement(q?.partyId ?? ""), q?.currency, q?.from, q?.to],
    enabled: q !== null,
    queryFn: async () => loadStatement(await phone(), q!),
    placeholderData: (previous) => previous,
  });
}
