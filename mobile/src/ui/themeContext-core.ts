// The theme context without any storage dependency, so every view (and its unit test) can read it.
import { createContext, useContext } from "react";
import { colors, type Colors, type ThemeName } from "./theme";

export interface ThemeApi {
  theme: ThemeName;
  setTheme(name: ThemeName): void;
}

export const ThemeCtx = createContext<ThemeApi>({ theme: "dark", setTheme: () => undefined });

export function useTheme(): ThemeApi {
  return useContext(ThemeCtx);
}

/**
 * The active theme's colours. Every component that paints with a colour calls this, so a theme switch re-renders it in
 * place (no navigator remount, no lost screen state). The object is the shared `colors` of theme.ts, already switched.
 */
export function useColors(): Colors {
  useContext(ThemeCtx);
  return colors;
}
