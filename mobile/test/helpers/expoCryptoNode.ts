// Test-only stand-in for `expo-crypto` under Node (the native module does not exist there).
import { randomBytes, randomUUID as nodeRandomUUID } from "node:crypto";

export const randomUUID = (): string => nodeRandomUUID();
export const getRandomBytes = (n: number): Uint8Array => new Uint8Array(randomBytes(n));
