import { useEffect, useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { logError } from "../../../../src/core/devlog";
import type { PartyDocKind } from "../../../../src/core/parties";
import {
  usePartyDocuments,
  usePartyProfile,
  useRememberParty,
} from "../../../../src/hooks/useParties";
import { useRole } from "../../../../src/hooks/useRole";
import { PartyDetailView } from "../../../../src/ui/PartyViews";
import { ErrorState, LoadingState, readErrorText, Screen } from "../../../../src/ui/kit";

export default function PartyScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const role = useRole();
  const remember = useRememberParty();
  const [tab, setTab] = useState<PartyDocKind>("invoices");
  const profile = usePartyProfile(id);
  const docs = usePartyDocuments(id, tab);
  useEffect(() => {
    remember(id).catch((e) => logError("remember-party", e));
  }, [id]);
  const party = profile.data;
  if (!party)
    return (
      <Screen title="الطرف">
        {profile.isLoading ? (
          <LoadingState />
        ) : (
          <ErrorState
            message={
              profile.error ? readErrorText(profile.error) : "هذا الطرف غير موجود على الهاتف."
            }
            onRetry={() => void profile.refetch()}
          />
        )}
      </Screen>
    );
  const customer = party.kind === "customer";
  return (
    <PartyDetailView
      party={party}
      role={role}
      tab={tab}
      docs={docs.data}
      onTab={setTab}
      onStatement={() => router.push(`/(tabs)/parties/${id}/statement` as never)}
      onEdit={() => router.push({ pathname: "/(tabs)/parties/form", params: { id } } as never)}
      onOpenDoc={(d) => d.kind === "invoice" && router.push(`/invoices/${d.id}` as never)}
      onNewInvoice={() =>
        router.push({
          pathname: customer ? "/(tabs)/add/sale" : "/(tabs)/add/entry",
          params: { partyId: id },
        } as never)
      }
      onNewVoucher={() =>
        router.push({
          pathname: customer ? "/(tabs)/add/receipt" : "/(tabs)/add/payment",
          params: { partyId: id },
        } as never)
      }
    />
  );
}
