// Bottom tabs in RTL order: Home, parties, add, inventory, more (UX-04). Write tabs hide for read-only roles.
import { useEffect, useState } from "react";
import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import type { Role } from "../../src/core/roles";
import { getSessionService } from "../../src/core/sessionService";
import { visibleTabs } from "../../src/core/tabs";
import { fontFamilyFor } from "../../src/ui/fontFamilies";

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
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.border, height: 64 },
        tabBarLabelStyle: { fontFamily: fontFamilyFor("500"), fontSize: 12 },
        sceneStyle: { backgroundColor: colors.background },
      }}
    >
      {visibleTabs("admin").map((t) => (
        <Tabs.Screen
          key={t.name}
          name={t.name}
          options={{
            title: t.title,
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
