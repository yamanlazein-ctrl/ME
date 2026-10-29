// Design tokens: GENERATED from the desktop's src/styles.css (scripts/gen-tokens.mjs → tokens.generated.ts). The desktop's
// default is the DARK theme (near-black surfaces + warm yellow accent), with a soft LIGHT theme; the phone follows the same
// default and offers the same two themes. `colors` is one mutable object so every component reads the active theme at render.
import { darkTokens, lightTokens } from "./tokens.generated";

export type ThemeName = "dark" | "light";

function build(name: ThemeName) {
  const t = name === "dark" ? darkTokens : lightTokens;
  return {
    ...t,
    /** Negative amounts and error text: the desktop's destructive colour (a darker red on the light theme for contrast). */
    negative: name === "dark" ? t.destructive : "#b91c1c",
    /** Success text. */
    positive: name === "dark" ? t.success : "#15803d",
    /** Muted fills for chips (selected = primary). */
    chip: t.muted,
  };
}

export type Colors = ReturnType<typeof build>;

export const colors: Colors = { ...build("dark") };
let current: ThemeName = "dark";

export function themeColors(name: ThemeName): Colors {
  return build(name);
}

export function getTheme(): ThemeName {
  return current;
}

/** Switches the active theme in place; the root layout re-renders the tree afterwards. */
export function applyTheme(name: ThemeName): void {
  current = name;
  Object.assign(colors, build(name));
}

/** Corner radius in dp: the desktop's --radius 0.625rem and its sm/md/lg/xl steps. */
export const radius = { sm: 6, md: 8, lg: 10, xl: 14 } as const;

/** Spacing scale in dp (UX: more air than the desktop). */
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/** Font sizes in sp. Body text is never below 16 sp (constitution VIII). */
export const fontSize = {
  body: 16,
  input: 16,
  button: 16,
  caption: 16,
  title: 20,
  headline: 24,
  amount: 20,
} as const;

/** Minimum touch target in dp. */
export const TOUCH_TARGET = 48;

/** The desktop font family (src/styles.css --font-sans): IBM Plex Sans Arabic, bundled in the APK (see ui/fonts.ts). */
export const fontFamily = "IBMPlexSansArabic_400Regular";
