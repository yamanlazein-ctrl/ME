import { useState } from "react";
import { router } from "expo-router";
import { useParties } from "../../../src/hooks/useParties";
import { useRole } from "../../../src/hooks/useRole";
import { PartyListView, type KindFilter } from "../../../src/ui/PartyViews";

export default function Parties() {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<KindFilter>("");
  const { data } = useParties(q, kind);
  const role = useRole();
  return (
    <PartyListView
      rows={data}
      q={q}
      kind={kind}
      role={role}
      onQuery={setQ}
      onKind={setKind}
      onOpen={(id) => router.push(`/(tabs)/parties/${id}` as never)}
      onNew={() =>
        router.push({
          pathname: "/(tabs)/parties/form",
          params: { kind: kind === "supplier" ? "supplier" : "customer" },
        } as never)
      }
    />
  );
}
