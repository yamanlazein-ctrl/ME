import { createContext, useContext, type ReactNode } from "react";

/**
 * What the app shell adds to every screen header: the sync chip (signed in only) and app-wide banners (update offers).
 * Screens stay free of the shell's hooks, so their views render in unit tests without it.
 */
export interface HeaderSlot {
  accessory: ReactNode;
  banner: ReactNode;
}

export const HeaderSlotCtx = createContext<HeaderSlot>({ accessory: null, banner: null });

export function useHeaderSlot(): HeaderSlot {
  return useContext(HeaderSlotCtx);
}
