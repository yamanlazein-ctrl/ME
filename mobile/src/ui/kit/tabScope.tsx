import { createContext, useContext, type ReactNode } from "react";

// Screens inside the bottom tabs sit above the tab bar, which already leaves room for the phone's navigation bar;
// screens outside the tabs (invoice page, login) must leave that room themselves.
const InTabs = createContext(false);

export function TabScope({ children }: { children: ReactNode }) {
  return <InTabs.Provider value={true}>{children}</InTabs.Provider>;
}

export function useInTabs(): boolean {
  return useContext(InTabs);
}
