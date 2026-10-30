import { DarkTheme, DefaultTheme, type Theme } from "expo-router";
import type { Colors, ThemeName } from "../theme";

/** The navigation library's theme built from our tokens, so no scene or tab bar ever falls back to its own white. */
export function navTheme(name: ThemeName, colors: Colors): Theme {
  const base = name === "dark" ? DarkTheme : DefaultTheme;
  return {
    ...base,
    dark: name === "dark",
    colors: {
      ...base.colors,
      primary: colors.primary,
      background: colors.background,
      card: colors.card,
      text: colors.foreground,
      border: colors.border,
      notification: colors.destructive,
    },
  };
}
