import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { Text } from "../../src/ui/Text";
import { router } from "expo-router";
import { describeError } from "../../src/core/devlog";

import { getSessionService } from "../../src/core/sessionService";
import type { Role } from "../../src/core/roles";
import { useDashboard } from "../../src/hooks/useDashboard";
import { useSyncStatus } from "../../src/hooks/useSyncStatus";
import { HomeView, type HomeAction } from "../../src/ui/HomeView";
import { useColors } from "../../src/ui/themeContext-core";

// Targets of the quick actions.
const TARGET: Record<HomeAction, string> = {
  sale: "/(tabs)/add/sale/customer",
  receipt: "/(tabs)/add/receipt",
  payment: "/(tabs)/add/payment",
  expense: "/(tabs)/add/expense",
  findParty: "/(tabs)/parties",
};

export default function Home() {
  const colors = useColors();
  const { data, error, isLoading } = useDashboard();
  const status = useSyncStatus();
  const [role, setRole] = useState<Role>("viewer");
  useEffect(() => {
    void getSessionService().then(async (s) => {
      const session = await s.current();
      if (session) setRole(session.role);
    });
  }, []);
  if (isLoading || (!error && !data)) return <ActivityIndicator style={{ flex: 1 }} />;
  if (error || !data) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <Text>تعذّر تحميل البيانات</Text>
        <Text
          testID="home-error"
          style={{ color: colors.negative, marginTop: 8, textAlign: "center" }}
        >
          {error ? describeError(error) : ""}
        </Text>
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
