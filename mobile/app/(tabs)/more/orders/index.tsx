import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { getApp } from "../../../../src/core/appRuntime";
import { canWriteOffline } from "../../../../src/core/roles";
import { listOrders } from "../../../../src/core/orders";
import { useRole } from "../../../../src/hooks/useRole";
import { OrderListView } from "../../../../src/ui/OrderViews";

export default function Orders() {
  const role = useRole();
  const { data } = useQuery({
    queryKey: ["orders"],
    queryFn: async () => {
      const app = await getApp();
      return app.phone ? listOrders(app.phone) : [];
    },
  });
  return (
    <OrderListView
      rows={data ?? []}
      canWrite={canWriteOffline(role)}
      onOpen={(id) => router.push(`/(tabs)/more/orders/${id}` as never)}
      onNew={() => router.push("/(tabs)/more/orders/new" as never)}
    />
  );
}
