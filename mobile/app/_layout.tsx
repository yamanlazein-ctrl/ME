import { Stack } from "expo-router";
import "../src/core";

export default function RootLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
