import { useRef, useState, type ComponentRef, type Ref } from "react";
import { Pressable, TextInput, View, type TextInputProps } from "react-native";
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
type InputInstance = ComponentRef<typeof TextInput>;

/**
 * Android's text field keeps a swipe that starts on it (RN's ReactEditText lets the page scroll only when the field
 * itself cannot scroll sideways, and an RTL one says it can), so a form could not be scrolled by dragging over its
 * fields. A field that is not being typed in therefore takes no touches itself: a tap focuses it, a swipe scrolls the
 * page. While focused it behaves natively (cursor, selection).
 */
export function useTouchSafeInput(
  inputRef: Ref<InputInstance> | undefined,
  input: Pick<TextInputProps, "onFocus" | "onBlur" | "editable">,
) {
  const own = useRef<InputInstance | null>(null);
  const [focused, setFocused] = useState(false);
  const ref = (node: InputInstance | null) => {
    own.current = node;
    if (typeof inputRef === "function") inputRef(node);
    else if (inputRef) (inputRef as { current: InputInstance | null }).current = node;
  };
  return {
    focused,
    ref,
    focus: () => {
      if (input.editable !== false) own.current?.focus();
    },
    onFocus: (e: Parameters<NonNullable<TextInputProps["onFocus"]>>[0]) => {
      setFocused(true);
      input.onFocus?.(e);
    },
    onBlur: (e: Parameters<NonNullable<TextInputProps["onBlur"]>>[0]) => {
      setFocused(false);
      input.onBlur?.(e);
    },
  };
}

export function Field({ label, fieldId, error, inputRef, ...input }: FieldProps) {
  const colors = useColors();
  const labelId = `${fieldId}-label`;
  const touch = useTouchSafeInput(inputRef, input);
  return (
    <View style={{ marginBottom: spacing.lg }}>
      <Text
        nativeID={labelId}
        style={{ fontSize: fontSize.body, color: colors.foreground, marginBottom: spacing.xs }}
      >
        {label}
      </Text>
      <Pressable
        accessible={false}
        onPress={touch.focus}
        testID={`${fieldId}-touch`}
        style={{ minHeight: TOUCH_TARGET }}
      >
        <View pointerEvents={touch.focused ? "auto" : "none"}>
          <TextInput
            maxFontSizeMultiplier={1.4}
            {...input}
            ref={touch.ref}
            onFocus={touch.onFocus}
            onBlur={touch.onBlur}
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
        </View>
      </Pressable>
      {error ? (
        <Text style={{ fontSize: fontSize.caption, color: colors.negative, marginTop: spacing.xs }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
