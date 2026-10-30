import { useEffect, useState } from "react";
import { router } from "expo-router";
import * as Font from "expo-font";
import { FONT_BY_WEIGHT } from "../../../src/ui/fontFamilies";
import { useTheme } from "../../../src/ui/ThemeContext";
import { getSessionService } from "../../../src/core/sessionService";
import { notifyBootChanged } from "../../../src/hooks/useBoot";
import { ROLE_LABEL } from "../../../src/ui/LoginView";
import { MoreMenuView, type MoreTarget } from "../../../src/ui/MoreMenu";

const ROUTE: Record<MoreTarget, string> = {
  returns: "/(tabs)/more/returns",
  orders: "/(tabs)/more/orders",
  cashbox: "/(tabs)/more/cashbox",
  closeDay: "/(tabs)/more/close-day",
  reports: "/(tabs)/more/reports",
  sync: "/(tabs)/more/sync",
};

function fontsStatus(): string {
  const names = ["ionicons", ...Object.values(FONT_BY_WEIGHT)];
  const missing = names.filter((n) => !Font.isLoaded(n));
  return missing.length === 0 ? "الخطوط والأيقونات: محمّلة" : `خطوط ناقصة: ${missing.join(", ")}`;
}

export default function More() {
  const { theme, setTheme } = useTheme();
  const [user, setUser] = useState<{ name: string; role: keyof typeof ROLE_LABEL } | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  useEffect(() => {
    void getSessionService().then(async (s) => {
      const session = await s.current();
      if (session) setUser({ name: session.name, role: session.role });
    });
  }, []);
  return (
    <MoreMenuView
      userName={user?.name ?? null}
      roleLabel={user ? ROLE_LABEL[user.role] : null}
      theme={theme}
      pendingLogout={pending}
      fontsStatus={fontsStatus()}
      onOpen={(t) => router.push(ROUTE[t] as never)}
      onTheme={setTheme}
      onCancelLogout={() => setPending(null)}
      onLogout={async (confirmed) => {
        const service = await getSessionService();
        const result = await service.logout({ confirmed });
        if (result.needsConfirm) return setPending(result.pending);
        setPending(null);
        notifyBootChanged();
      }}
    />
  );
}
