import { useState } from "react";
import { router } from "expo-router";
import { usePartyList, usePartyListBalances } from "../../../src/hooks/useParties";
import { useRole } from "../../../src/hooks/useRole";
import { PartyListView, type KindFilter } from "../../../src/ui/PartyViews";

export default function Parties() {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<KindFilter>("");
  const list = usePartyList(q, kind);
  const balances = usePartyListBalances(list.data);
  const role = useRole();
  return (
    <PartyListView
      rows={list.data}
      balances={balances.data ?? {}}
      q={q}
      kind={kind}
      role={role}
      loading={list.isLoading}
      error={list.error}
      refreshing={list.isRefetching}
      onQuery={setQ}
      onKind={setKind}
      onOpen={(id) => router.push(`/(tabs)/parties/${id}` as never)}
      onNew={() =>
        router.push({
          pathname: "/(tabs)/parties/form",
          params: { kind: kind === "supplier" ? "supplier" : "customer" },
        } as never)
      }
      onRefresh={() => void list.refetch()}
      onRetry={() => void list.refetch()}
    />
  );
}
