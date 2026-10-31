import type { ReactNode } from "react";

/** The phone's insets in tests; a test sets `bottom` to stand for a navigation bar and resets it after. */
export const stubInsets = { top: 0, bottom: 0, left: 0, right: 0 };
export const useSafeAreaInsets = () => stubInsets;
export const SafeAreaProvider = ({ children }: { children: ReactNode }) => children;
