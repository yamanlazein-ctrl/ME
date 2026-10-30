import { Buffer } from "buffer";
// Offline PIN verifier (FR-05, research R9): Argon2id with the desktop's parameters, copied from
// backend/src/infrastructure/auth/PasswordHasher.ts (memoryCost 65536 KiB, timeCost 3, parallelism 4,
// Argon2id, @node-rs/argon2 default 32-byte output, 16-byte random salt). The output is the standard PHC
// string `$argon2id$v=19$m=65536,t=3,p=4$<salt>$<hash>`, which the backend's `verify` accepts too.
import argon2 from "react-native-argon2";
import { randomBytes } from "./nodeCrypto";

export const ARGON2_PARAMS = {
  iterations: 3,
  memory: 65536,
  parallelism: 4,
  hashLength: 32,
  mode: "argon2id" as const,
  saltEncoding: "hex" as const,
};

const SALT_BYTES = 16;

export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES).toString("hex");
  const { encodedHash } = await argon2(pin, salt, ARGON2_PARAMS);
  return encodedHash;
}

interface Phc {
  memory: number;
  iterations: number;
  parallelism: number;
  saltHex: string;
  hash: string;
}

function parsePhc(stored: string): Phc | null {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/.exec(stored);
  if (!m) return null;
  const saltB64 = m[4] as string;
  const padded = saltB64 + "=".repeat((4 - (saltB64.length % 4)) % 4);
  const saltHex = Buffer.from(padded, "base64").toString("hex");
  return {
    memory: Number(m[1]),
    iterations: Number(m[2]),
    parallelism: Number(m[3]),
    saltHex,
    hash: m[5] as string,
  };
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const phc = parsePhc(stored);
  if (!phc) return false;
  const { encodedHash } = await argon2(pin, phc.saltHex, {
    ...ARGON2_PARAMS,
    iterations: phc.iterations,
    memory: phc.memory,
    parallelism: phc.parallelism,
  });
  const again = parsePhc(encodedHash);
  return again !== null && again.hash === phc.hash;
}
