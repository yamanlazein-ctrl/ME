import { Stack } from "expo-router";
import { useColors } from "../themeContext-core";

/** Every stack of the app: our own screen headers (kit/Screen), and the active theme's background behind each scene. */
export function ThemedStack() {
  const colors = useColors();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
        animation: "slide_from_left",
      }}
    />
  );
}
