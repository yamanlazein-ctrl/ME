import { useEffect } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { logError } from "../../../../src/core/devlog";
import { getApp } from "../../../../src/core/appRuntime";
import { balancesByCurrency, recentInvoices } from "../../../../src/core/partyQueries";
import { useRememberParty } from "../../../../src/hooks/useParties";
import { queryKeys } from "../../../../src/hooks/queryKeys";
import { useRole } from "../../../../src/hooks/useRole";
import { describeError } from "../../../../src/core/devlog";
import { Text } from "../../../../src/ui/Text";

import { PartyDetailView, type PartyDetail } from "../../../../src/ui/PartyViews";
import { useColors } from "../../../../src/ui/themeContext-core";

export default function PartyScreen() {
  const colors = useColors();
  const { id } = useLocalSearchParams<{ id: string }>();
  const role = useRole();
  const remember = useRememberParty();
  useEffect(() => {
    remember(id).catch((e) => logError("remember-party", e));
  }, [id]);
  const { data, error } = useQuery({
    queryKey: queryKeys.party(id),
    queryFn: async (): Promise<PartyDetail | null> => {
      const app = await getApp();
      if (!app.phone) return null;
      const party = await app.phone.repos.partyRepo.findById(id, app.phone.context());
      if (!party) return null;
      const kind = party.kind === "supplier" ? "supplier" : "customer";
      return {
        id,
        name: party.name,
        kind,
        phone: party.phone ?? party.mobile ?? null,
        balances: await balancesByCurrency(app.phone, id, kind),
        invoices: (await recentInvoices(app.phone, id)).map((i) => ({
          id: i.id,
          number: i.number,
          date: i.date,
          total: i.total,
          currency: i.currency,
        })),
      };
    },
  });
  if (error) {
    return (
      <Text testID="party-error" style={{ color: colors.negative, padding: 16 }}>
        {`تعذّر تحميل الطرف: ${describeError(error)}`}
      </Text>
    );
  }
  if (!data) return null;
  return (
    <PartyDetailView
      party={data}
      role={role}
      onStatement={() => router.push(`/(tabs)/parties/${id}/statement` as never)}
      onEdit={() => router.push({ pathname: "/(tabs)/parties/form", params: { id } } as never)}
      onInvoice={(invoiceId) => router.push(`/invoices/${invoiceId}` as never)}
    />
  );
}
