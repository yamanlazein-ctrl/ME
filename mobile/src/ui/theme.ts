// Design tokens copied from the desktop's src/styles.css (LIGHT theme only, clarification Q5). Colour values are the
// `.light` block; the semantic colours that the desktop writes in oklch are given as hex here (React Native has no oklch):
// destructive = Tailwind red-500, success = green-500, warning = amber-500. Text uses the darker `negative` / `positive`
// variants, which keep contrast ≥ 4.5:1 on the light surfaces (WCAG AA).
export const colors = {
  background: "#f7f8fa",
  foreground: "#1e293b",
  surface: "#f2f4f7",
  card: "#fafbfc",
  cardForeground: "#1e293b",
  popover: "#fcfcfd",
  primary: "#c89100",
  primaryForeground: "#ffffff",
  primaryGlow: "#e0a800",
  accentSoft: "#7d6000",
  secondary: "#edf0f4",
  secondaryForeground: "#1e293b",
  muted: "#edf0f4",
  mutedForeground: "#56657a",
  accent: "#e9edf2",
  accentForeground: "#1e293b",
  border: "#e2e8f0",
  input: "#d5dce5",
  ring: "#c89100",
  currencySyp: "#7d6000",
  currencyUsd: "#4b5563",
  destructive: "#ef4444",
  destructiveForeground: "#ffffff",
  success: "#22c55e",
  warning: "#f59e0b",
  /** Negative amounts and error text. */
  negative: "#b91c1c",
  /** Success text. */
  positive: "#15803d",
} as const;

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

/** The desktop font (IBM Plex Sans Arabic) is not bundled; the phone uses the system Arabic font. */
export const fontFamily = undefined;
