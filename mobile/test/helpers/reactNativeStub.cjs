// Test-only stand-in for `react-native` under Node (CommonJS so that libraries which `require("react-native")` get it too:
// see test/setup.ts). Host components are plain elements named like the real ones, which is what
// @testing-library/react-native queries by. Only the pieces the phone UI uses exist.
const { createElement } = require("react");

const host = (name) => {
  const component = (props) => createElement(name, props);
  component.displayName = name;
  return component;
};

const StyleSheet = {
  create: (styles) => styles,
  flatten: (style) =>
    Array.isArray(style)
      ? Object.assign({}, ...style.map((s) => StyleSheet.flatten(s)))
      : (style ?? {}),
  hairlineWidth: 1,
  absoluteFill: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 },
};

const FlatList = (props) =>
  createElement(
    "FlatList",
    { ...props, data: undefined, renderItem: undefined },
    (props.data ?? []).map((item, index) =>
      createElement("Item", { key: index }, props.renderItem?.({ item, index })),
    ),
  );

module.exports = {
  View: host("View"),
  Text: host("Text"),
  TextInput: host("TextInput"),
  ScrollView: host("ScrollView"),
  FlatList,
  // A disabled Pressable does not react to presses (the real one ignores them too).
  Pressable: Object.assign(
    ({ disabled, onPress, ...rest }) =>
      createElement("Pressable", {
        ...rest,
        disabled,
        // What the real Pressable's host View exposes; @testing-library/react-native uses it to skip presses.
        onStartShouldSetResponder: () => !disabled,
        ...(disabled ? {} : { onPress }),
      }),
    { displayName: "Pressable" },
  ),
  ActivityIndicator: host("ActivityIndicator"),
  // Like the real Modal: nothing is on screen while `visible` is false.
  Modal: (props) => (props.visible === false ? null : createElement("Modal", props)),
  KeyboardAvoidingView: host("KeyboardAvoidingView"),
  SafeAreaView: host("SafeAreaView"),
  StyleSheet,
  Platform: { OS: "android", select: (o) => o.android ?? o.default },
  I18nManager: { isRTL: true, allowRTL: () => undefined, forceRTL: () => undefined },
  Keyboard: { addListener: () => ({ remove: () => undefined }), dismiss: () => undefined },
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
  Alert: { alert: () => undefined },
  Linking: { openURL: async () => undefined },
  useWindowDimensions: () => ({ width: 360, height: 800, scale: 2, fontScale: 1 }),
  PixelRatio: { getFontScale: () => 1 },
};
