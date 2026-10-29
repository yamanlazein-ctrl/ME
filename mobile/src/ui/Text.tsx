import { StyleSheet, Text as RNText, type TextProps } from "react-native";
import { colors } from "./theme";
import { fontFamilyFor } from "./fontFamilies";

/** `Text` with the desktop font and the active theme's foreground colour as defaults. */
export function Text({ style, ...props }: TextProps) {
  const flat = StyleSheet.flatten(style) ?? {};
  return (
    <RNText
      {...props}
      style={[
        {
          color: colors.foreground,
          fontFamily: fontFamilyFor(flat.fontWeight),
          fontSize: 16,
          lineHeight: 25,
        },
        style,
        // Android picks the weight from the family; a numeric weight on a custom family would be synthesised twice.
        flat.fontWeight ? { fontWeight: "normal" } : null,
      ]}
    />
  );
}
