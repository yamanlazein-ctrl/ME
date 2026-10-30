import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { readAppState, updateAppState } from "../core/appState";
import { logError } from "../core/devlog";
import { applyTheme, getTheme, type ThemeName } from "./theme";
import { ThemeCtx } from "./themeContext-core";

/** Applies the saved theme (dark by default, like the desktop) and re-renders the tree when it changes. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeName>(getTheme());
  useEffect(() => {
    readAppState()
      .then((s) => {
        applyTheme(s.theme);
        setThemeState(s.theme);
      })
      .catch((e) => logError("theme", e));
  }, []);
  const setTheme = useCallback((name: ThemeName) => {
    applyTheme(name);
    setThemeState(name);
    updateAppState({ theme: name }).catch((e) => logError("theme", e));
  }, []);
  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export { useColors, useTheme } from "./themeContext-core";
