# FIX-04 — the desktop's identity on the phone

- Tokens are GENERATED from the desktop's `src/styles.css` (`mobile/scripts/gen-tokens.mjs` → `src/ui/tokens.generated.ts`; oklch values
  converted to hex). The desktop's default is its DARK theme (#0a0a0a surfaces, #ffd740 accent), with a soft light theme; the phone now
  starts dark like the Windows app and offers the same two themes (More → المظهر; saved in `app-state.json`). `colors` is one mutable
  object, so every screen follows the active theme; text on the accent colour uses `primaryForeground` (no hard-coded white).
- Font: IBM Plex Sans Arabic (the desktop's `--font-sans`) in the four weights the desktop loads (`@expo-google-fonts/ibm-plex-sans-arabic`),
  applied through `src/ui/Text.tsx` and `Field`.
- Logo: the desktop's `logo-motard-icon.png` (identical to `mobile/assets/logo.png`) now appears in the header strip of every screen; the app
  icon, adaptive icon and splash are built from it on the desktop's near-black background.
- Layout: RTL, 48 dp touch targets, 16 sp minimum text, the primary action fixed at the bottom (unchanged rules). Theme tests:
  `theme.test.ts` (tokens equal the desktop's, WCAG AA contrast on both themes).
