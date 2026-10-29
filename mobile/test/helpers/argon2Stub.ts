// Test-only stand-in for react-native-argon2 (a native module). Tests that need it mock it with vi.mock.
export default async function argon2(): Promise<never> {
  throw new Error("react-native-argon2 is not available under Node");
}
