import { ActivityIndicator, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { getApp } from "../../../../src/core/appRuntime";
import { canWriteOffline } from "../../../../src/core/roles";
import { useRole } from "../../../../src/hooks/useRole";
import { useStatement } from "../../../../src/hooks/useStatement";
import { SendToCustomer } from "../../../../src/ui/SendToCustomer";
import { StatementView } from "../../../../src/ui/PartyViews";

export default function StatementScreen() {
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
  const statement = useStatement(id, kindQuery.data ?? "customer");
  if (!kindQuery.data || !statement.data) return <ActivityIndicator style={{ flex: 1 }} />;
  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 16 }}>
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
