import { StyleSheet, Text as RNText, type TextProps } from "react-native";

import { fontFamilyFor } from "./fontFamilies";
import { useColors } from "./themeContext-core";

/** `Text` with the desktop font and the active theme's foreground colour as defaults. */
export function Text({ style, ...props }: TextProps) {
  const colors = useColors();
  const flat = StyleSheet.flatten(style) ?? {};
  return (
    <RNText
      {...props}
      style={[
        { color: colors.foreground, fontFamily: fontFamilyFor(flat.fontWeight) },
        style,
        // Android picks the weight from the family; a numeric weight on a custom family would be synthesised twice.
        flat.fontWeight ? { fontWeight: "normal" } : null,
      ]}
    />
  );
}
