import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async (k: string) => store.get(k) ?? null),
  setItemAsync: vi.fn(async (k: string, v: string) => void store.set(k, v)),
  deleteItemAsync: vi.fn(async (k: string) => void store.delete(k)),
}));

import {
  deleteAllSecrets,
  deleteSecret,
  getOrCreateDbKey,
  getSecret,
  listSecretKeys,
  setSecret,
} from "../../src/platform/secureStore";

beforeEach(() => store.clear());

describe("secureStore", () => {
  it("prefixes keys with motard. and round-trips values", async () => {
    await setSecret("accessToken", "abc");
    expect(await getSecret("accessToken")).toBe("abc");
    expect([...store.keys()]).toContain("motard.accessToken");
    expect(await listSecretKeys()).toEqual(["accessToken"]);
    await deleteSecret("accessToken");
    expect(await getSecret("accessToken")).toBeNull();
    expect(await listSecretKeys()).toEqual([]);
  });

  it("rewrites characters expo-secure-store rejects", async () => {
    await setSecret("pin:user/1", "v");
    expect([...store.keys()]).toContain("motard.pin_user_1");
  });

  it("getOrCreateDbKey makes 32 random bytes hex once and returns the same value after", async () => {
    const first = await getOrCreateDbKey();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await getOrCreateDbKey()).toBe(first);
    expect(await getOrCreateDbKey()).toBe(first);
  });

  it("deleteAllSecrets removes every motard.* entry", async () => {
    await setSecret("a", "1");
    await setSecret("b", "2");
    await getOrCreateDbKey();
    await deleteAllSecrets();
    expect([...store.keys()]).toEqual([]);
  });
});
