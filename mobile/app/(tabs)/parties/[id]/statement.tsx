import { useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { getApp } from "../../../../src/core/appRuntime";
import { balancesByCurrency } from "../../../../src/core/partyQueries";
import { canWriteOffline } from "../../../../src/core/roles";
import { useRole } from "../../../../src/hooks/useRole";
import { useStatement } from "../../../../src/hooks/useStatement";
import { SendToCustomer } from "../../../../src/ui/SendToCustomer";
import { Text } from "../../../../src/ui/Text";

import { StatementView } from "../../../../src/ui/PartyViews";
import { useColors } from "../../../../src/ui/themeContext-core";

export default function StatementScreen() {
  const colors = useColors();
  const { id } = useLocalSearchParams<{ id: string }>();
  const role = useRole();
  const kindQuery = useQuery({
    queryKey: ["party-kind", id],
    queryFn: async () => {
      const app = await getApp();
      const party = app.phone
        ? await app.phone.repos.partyRepo.findById(id, app.phone.context())
        : null;
      return party?.kind === "supplier" ? ("supplier" as const) : ("customer" as const);
    },
  });
  const balances = useQuery({
    queryKey: ["party-balances", id, kindQuery.data],
    enabled: Boolean(kindQuery.data),
    queryFn: async () => {
      const app = await getApp();
      return app.phone && kindQuery.data
        ? balancesByCurrency(app.phone, id, kindQuery.data)
        : ({} as Record<string, number>);
    },
  });
  const currencies = Object.keys(balances.data ?? {}).sort();
  const [chosen, setChosen] = useState<string | null>(null);
  const currency =
    chosen ?? currencies.find((c) => (balances.data?.[c] ?? 0) !== 0) ?? currencies[0];
  const statement = useStatement(id, kindQuery.data ?? "customer", currency);
  if (!kindQuery.data || !balances.data || !statement.data)
    return <ActivityIndicator style={{ flex: 1 }} />;
  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 16 }}>
        {currencies.length > 1 ? (
          <View style={{ flexDirection: "row", gap: 8, marginTop: 8 }}>
            {currencies.map((c) => (
              <Pressable
                key={c}
                accessibilityRole="button"
                accessibilityLabel={`كشف ${c}`}
                accessibilityState={{ selected: currency === c }}
                onPress={() => setChosen(c)}
                style={{
                  minHeight: 48,
                  justifyContent: "center",
                  paddingHorizontal: 16,
                  borderRadius: 8,
                  backgroundColor: currency === c ? colors.primary : colors.muted,
                }}
              >
                <Text
                  style={{ color: currency === c ? colors.primaryForeground : colors.foreground }}
                >
                  {c}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <SendToCustomer
          docRef={{ type: "statement", partyId: id, kind: kindQuery.data }}
          label="إرسال الكشف للعميل"
        />
      </View>
      <StatementView
        entries={statement.data.entries}
        closing={statement.data.header.finalBalance}
        {...(canWriteOffline(role)
          ? {
              onAmend: (entry) =>
                router.push({
                  pathname:
                    entry.type === "receipt_in" ? "/(tabs)/add/receipt" : "/(tabs)/add/payment",
                  params: { amendId: entry.referenceId },
                } as never),
            }
          : {})}
      />
    </View>
  );
}
