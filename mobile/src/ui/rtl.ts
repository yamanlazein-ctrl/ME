import { I18nManager } from "react-native";

/**
 * RTL comes from the expo-localization plugin settings in app.json (supportsRTL + forcesRTL), so no runtime reload is
 * needed. This only checks it at start-up and logs an error otherwise (UX-06).
 */
export function assertRtl(): boolean {
  if (I18nManager.isRTL === true) return true;
  console.error(
    "RTL is not active: the expo-localization plugin settings in app.json were not applied",
  );
  return false;
}
