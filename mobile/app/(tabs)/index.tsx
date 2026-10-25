import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { router } from "expo-router";
import { getSessionService } from "../../src/core/sessionService";
import type { Role } from "../../src/core/roles";
import { useDashboard } from "../../src/hooks/useDashboard";
import { useSyncStatus } from "../../src/hooks/useSyncStatus";
import { HomeView, type HomeAction } from "../../src/ui/HomeView";

// Targets of the quick actions.
const TARGET: Record<HomeAction, string> = {
  sale: "/(tabs)/add/sale/customer",
  receipt: "/(tabs)/add/receipt",
  payment: "/(tabs)/add/payment",
  expense: "/(tabs)/add/expense",
  findParty: "/(tabs)/parties",
};

export default function Home() {
  const { data, error, isLoading } = useDashboard();
  const status = useSyncStatus();
  const [role, setRole] = useState<Role>("viewer");
  useEffect(() => {
    void getSessionService().then(async (s) => {
      const session = await s.current();
      if (session) setRole(session.role);
    });
  }, []);
  if (isLoading) return <ActivityIndicator style={{ flex: 1 }} />;
  if (error || !data) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <Text>تعذّر تحميل البيانات</Text>
      </View>
    );
  }
  return (
    <HomeView
      data={data}
      role={role}
      lastSyncAt={status.lastRunAt}
      onAction={(a) => router.push(TARGET[a] as never)}
    />
  );
}
