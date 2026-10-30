import type { ReactNode } from "react";

export const useSafeAreaInsets = () => ({ top: 0, bottom: 0, left: 0, right: 0 });
export const SafeAreaProvider = ({ children }: { children: ReactNode }) => children;
