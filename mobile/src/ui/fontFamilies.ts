// Font family names of the bundled IBM Plex Sans Arabic weights (pure: safe to import anywhere, including tests).
export const FONT_BY_WEIGHT = {
  "400": "IBMPlexSansArabic_400Regular",
  "500": "IBMPlexSansArabic_500Medium",
  "600": "IBMPlexSansArabic_600SemiBold",
  "700": "IBMPlexSansArabic_700Bold",
} as const;

/** The family for a React Native `fontWeight` (custom fonts on Android need one family per weight). */
export function fontFamilyFor(weight: unknown): string {
  const w = String(weight ?? "400");
  if (w === "bold" || w === "800" || w === "900" || w === "700") return FONT_BY_WEIGHT["700"];
  if (w === "600") return FONT_BY_WEIGHT["600"];
  if (w === "500") return FONT_BY_WEIGHT["500"];
  return FONT_BY_WEIGHT["400"];
}
