import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { AesGcmSecretStore, decodeMasterKey } from "@/infrastructure/secrets/AesGcmSecretStore";

/**
 * Phase 0 sub-batch 0B — secrets manager tests.
 *
 * No database needed: the cipher is pure crypto. The repository
 * integration is verified by the schema tests in 0A (the `secrets`
 * table exists with the right shape) and by the contract tests in
 * sub-batches 0E/0F/0G (where the secrets repo is actually used).
 */
describe("AesGcmSecretStore", () => {
  let key: Buffer;

  beforeEach(() => {
    key = randomBytes(32);
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => new AesGcmSecretStore(Buffer.alloc(16))).toThrow(/32 bytes/);
    expect(() => new AesGcmSecretStore(Buffer.alloc(64))).toThrow(/32 bytes/);
  });

  it("round-trips a plaintext", async () => {
    const store = new AesGcmSecretStore(key);
    const plaintext = "hello, world — هذا نص اختبار";
    const enc = await store.encrypt(plaintext);
    const dec = await store.encrypt(enc.ciphertext).then(() => null).catch(() => null);
    expect(dec).toBeNull();
    const out = await store.decrypt(enc);
    expect(out).toBe(plaintext);
  });

  it("returns a different IV on every encrypt call", async () => {
    const store = new AesGcmSecretStore(key);
    const a = await store.encrypt("same plaintext");
    const b = await store.encrypt("same plaintext");
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.algorithm).toBe("aes-256-gcm");
  });

  it("detects tampered ciphertext (auth tag mismatch)", async () => {
    const store = new AesGcmSecretStore(key);
    const enc = await store.encrypt("top secret");
    // Flip one byte of the ciphertext.
    const buf = Buffer.from(enc.ciphertext, "base64");
    buf[0] = buf[0] ^ 0x01;
    const tampered = { ...enc, ciphertext: buf.toString("base64") };
    await expect(store.decrypt(tampered)).rejects.toThrow();
  });

  it("detects tampered auth tag", async () => {
    const store = new AesGcmSecretStore(key);
    const enc = await store.encrypt("top secret");
    const buf = Buffer.from(enc.authTag!, "base64");
    buf[0] = buf[0] ^ 0x01;
    const tampered = { ...enc, authTag: buf.toString("base64") };
    await expect(store.decrypt(tampered)).rejects.toThrow();
  });

  it("rejects decrypt with a different key", async () => {
    const store1 = new AesGcmSecretStore(key);
    const enc = await store1.encrypt("secret");
    const store2 = new AesGcmSecretStore(randomBytes(32));
    await expect(store2.decrypt(enc)).rejects.toThrow();
  });

  it("supports key rotation", async () => {
    const store = new AesGcmSecretStore(key);
    const enc1 = await store.encrypt("rotate me");
    const newKey = randomBytes(32);
    await store.rotate(newKey);
    // After rotation, the new key cannot decrypt the old ciphertext.
    await expect(store.decrypt(enc1)).rejects.toThrow();
    // The new key encrypts and decrypts its own data.
    const enc2 = await store.encrypt("after rotation");
    const out = await store.decrypt(enc2);
    expect(out).toBe("after rotation");
  });

  it("returns a stable fingerprint of the current key", async () => {
    const store = new AesGcmSecretStore(key);
    const f1 = await store.fingerprint();
    const f2 = await store.fingerprint();
    expect(f1).toBe(f2);
    expect(f1).toMatch(/^[0-9a-f]{64}$/);
    await store.rotate(randomBytes(32));
    const f3 = await store.fingerprint();
    expect(f3).not.toBe(f1);
  });
});

describe("decodeMasterKey", () => {
  it("decodes a 32-byte base64 string", () => {
    const raw = randomBytes(32).toString("base64");
    const buf = decodeMasterKey(raw);
    expect(buf).not.toBeNull();
    expect(buf!.length).toBe(32);
  });

  it("returns null for missing input", () => {
    expect(decodeMasterKey(undefined)).toBeNull();
    expect(decodeMasterKey("")).toBeNull();
  });

  it("returns null for invalid base64", () => {
    expect(decodeMasterKey("not-base64-!!!")).toBeNull();
  });

  it("returns null for wrong byte length", () => {
    expect(decodeMasterKey(Buffer.from("short").toString("base64"))).toBeNull();
    expect(decodeMasterKey(randomBytes(16).toString("base64"))).toBeNull();
    expect(decodeMasterKey(randomBytes(64).toString("base64"))).toBeNull();
  });
});
