// Bottom tabs in RTL order: Home, parties, add, inventory, more (UX-04). Write tabs hide for read-only roles.
import { useEffect, useState } from "react";
import { Text as RNText } from "react-native";
import { Tabs } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import type { Role } from "../../src/core/roles";
import { getSessionService } from "../../src/core/sessionService";
import { visibleTabs } from "../../src/core/tabs";
import { fontFamilyFor } from "../../src/ui/fontFamilies";
import { TAB_BAR_HEIGHT } from "../../src/ui/theme";

import { useColors } from "../../src/ui/themeContext-core";

const ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  index: "home",
  parties: "people",
  add: "add-circle",
  inventory: "cube",
  more: "menu",
};

export default function TabsLayout() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [role, setRole] = useState<Role>("viewer");
  useEffect(() => {
    void getSessionService().then(async (s) => {
      const session = await s.current();
      if (session) setRole(session.role);
    });
  }, []);
  const shown = new Set(visibleTabs(role).map((t) => t.name));
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.mutedForeground,
        // Room for the icon and a one-line label, then the phone's navigation bar (3 buttons or gesture line) below
        // it: nothing of the bar may sit under the system buttons, on any phone or font size.
        tabBarStyle: {
          backgroundColor: colors.card,
          borderTopColor: colors.border,
          height: TAB_BAR_HEIGHT + insets.bottom,
          paddingTop: 4,
          paddingBottom: insets.bottom + 4,
        },
        tabBarLabel: ({ color, children }) => (
          <RNText
            numberOfLines={1}
            maxFontSizeMultiplier={1.2}
            style={{ color, fontFamily: fontFamilyFor("500"), fontSize: 12 }}
          >
            {children}
          </RNText>
        ),
        sceneStyle: { backgroundColor: colors.background },
      }}
    >
      {visibleTabs("admin").map((t) => (
        <Tabs.Screen
          key={t.name}
          name={t.name}
          options={{
            title: t.title,
            tabBarButtonTestID: `tab-${t.name}`,
            tabBarIcon: ({ color, size }) => (
              <Ionicons name={ICONS[t.name] ?? "ellipse"} size={size} color={color as string} />
            ),
            href: shown.has(t.name) ? undefined : null,
          }}
        />
      ))}
    </Tabs>
  );
}
