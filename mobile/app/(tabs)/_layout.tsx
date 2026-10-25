// Bottom tabs in RTL order: Home, parties, add, inventory, more (UX-04). Write tabs hide for read-only roles.
import { useEffect, useState } from "react";
import { Tabs } from "expo-router";
import { getSessionService } from "../../src/core/sessionService";
import type { Role } from "../../src/core/roles";
import { visibleTabs } from "../../src/core/tabs";

export default function TabsLayout() {
  const [role, setRole] = useState<Role>("viewer");
  useEffect(() => {
    void getSessionService().then(async (s) => {
      const session = await s.current();
      if (session) setRole(session.role);
    });
  }, []);
  const shown = new Set(visibleTabs(role).map((t) => t.name));
  return (
    <Tabs screenOptions={{ headerShown: false }}>
      {visibleTabs("admin").map((t) => (
        <Tabs.Screen
          key={t.name}
          name={t.name}
          options={{ title: t.title, href: shown.has(t.name) ? undefined : null }}
        />
      ))}
    </Tabs>
  );
}
