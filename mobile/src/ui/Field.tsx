import { TextInput, View, type TextInputProps } from "react-native";
import { Text } from "./Text";
import { fontFamilyFor } from "./fontFamilies";
import { colors, fontSize, radius, spacing, TOUCH_TARGET } from "./theme";

export interface FieldProps extends Omit<TextInputProps, "style"> {
  label: string;
  /** Stable id of the label; the input points at it with accessibilityLabelledBy (the desktop `FormField` rule). */
  fieldId: string;
  error?: string | null;
}

/** A label tied to its input: the input is labelled by the label's nativeID, and also carries the text itself. */
export function Field({ label, fieldId, error, ...input }: FieldProps) {
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
        nativeID={fieldId}
        testID={fieldId}
        accessibilityLabel={label}
        accessibilityLabelledBy={labelId}
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
