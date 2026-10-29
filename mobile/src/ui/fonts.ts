// Font loading. Fonts: IBM Plex Sans Arabic (the desktop's --font-sans) in the four weights the desktop loads, plus the Ionicons glyph font
// for the tab icons. Both are bundled in the APK as JavaScript assets and loaded before the first screen is shown.
import { useFonts } from "expo-font";
import { Ionicons } from "@expo/vector-icons";
import { FONT_BY_WEIGHT } from "./fontFamilies";
import {
  IBMPlexSansArabic_400Regular,
  IBMPlexSansArabic_500Medium,
  IBMPlexSansArabic_600SemiBold,
  IBMPlexSansArabic_700Bold,
} from "@expo-google-fonts/ibm-plex-sans-arabic";

/** Loads every bundled font; `true` once all are ready, and the error otherwise (never swallowed). */
export function useAppFonts(): { loaded: boolean; error: Error | null } {
  const [loaded, error] = useFonts({
    ...Ionicons.font,
    [FONT_BY_WEIGHT["400"]]: IBMPlexSansArabic_400Regular,
    [FONT_BY_WEIGHT["500"]]: IBMPlexSansArabic_500Medium,
    [FONT_BY_WEIGHT["600"]]: IBMPlexSansArabic_600SemiBold,
    [FONT_BY_WEIGHT["700"]]: IBMPlexSansArabic_700Bold,
  });
  return { loaded, error };
}
