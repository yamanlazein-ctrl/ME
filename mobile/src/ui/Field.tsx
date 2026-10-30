import type { ComponentRef, Ref } from "react";
import { TextInput, View, type TextInputProps } from "react-native";
import { Text } from "./Text";
import { fontFamilyFor } from "./fontFamilies";
import { fontSize, radius, spacing, TOUCH_TARGET } from "./theme";
import { useColors } from "./themeContext-core";

export interface FieldProps extends Omit<TextInputProps, "style"> {
  label: string;
  /** Stable id of the label; the input points at it with accessibilityLabelledBy (the desktop `FormField` rule). */
  fieldId: string;
  error?: string | null;
  /** To move focus here from the previous field («التالي» on the keyboard). */
  inputRef?: Ref<ComponentRef<typeof TextInput>>;
}

/** A label tied to its input: the input is labelled by the label's nativeID, and also carries the text itself. */
export function Field({ label, fieldId, error, inputRef, ...input }: FieldProps) {
  const colors = useColors();
  const labelId = `${fieldId}-label`;
  return (
    <View style={{ marginBottom: spacing.lg }}>
      <Text
        nativeID={labelId}
        style={{ fontSize: fontSize.body, color: colors.foreground, marginBottom: spacing.xs }}
      >
        {label}
      </Text>
      <TextInput
        {...input}
        ref={inputRef}
        nativeID={fieldId}
        testID={fieldId}
        accessibilityLabel={label}
        accessibilityLabelledBy={labelId}
        placeholderTextColor={colors.mutedForeground}
        style={{
          minHeight: TOUCH_TARGET,
          fontSize: fontSize.input,
          color: colors.foreground,
          backgroundColor: colors.card,
          borderColor: error ? colors.negative : colors.input,
          borderWidth: 1,
          borderRadius: radius.md,
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.sm,
          textAlign: "right",
          fontFamily: fontFamilyFor("400"),
        }}
      />
      {error ? (
        <Text style={{ fontSize: fontSize.caption, color: colors.negative, marginTop: spacing.xs }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
