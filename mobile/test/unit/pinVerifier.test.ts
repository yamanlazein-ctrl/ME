import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";

const calls: Array<{ password: string; salt: string; config: Record<string, unknown> }> = [];

// A stand-in that returns a real PHC string: the "hash" is derived deterministically from the inputs.
vi.mock("react-native-argon2", () => ({
  default: vi.fn(async (password: string, salt: string, config: Record<string, unknown>) => {
    calls.push({ password, salt, config });
    const saltB64 = Buffer.from(salt, "hex").toString("base64").replace(/=+$/, "");
    const fake = Buffer.from(`${password}|${salt}|${config.iterations}|${config.memory}`)
      .toString("base64")
      .replace(/=+$/, "");
    return {
      rawHash: "",
      encodedHash: `$argon2id$v=19$m=${config.memory},t=${config.iterations},p=${config.parallelism}$${saltB64}$${fake}`,
    };
  }),
}));

import { ARGON2_PARAMS, hashPin, verifyPin } from "../../src/platform/pinVerifier";

beforeEach(() => (calls.length = 0));

describe("pinVerifier", () => {
  it("hashes with the desktop's Argon2id parameters", async () => {
    const stored = await hashPin("1234");
    expect(calls[0]?.config).toMatchObject({
      iterations: 3,
      memory: 65536,
      parallelism: 4,
      mode: "argon2id",
      hashLength: 32,
    });
    expect(calls[0]?.salt).toMatch(/^[0-9a-f]{32}$/); // 16 random bytes
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
    expect(ARGON2_PARAMS.memory).toBe(65536);
  });

  it("verifies the right PIN and refuses a wrong one or a malformed record", async () => {
    const stored = await hashPin("4821");
    expect(await verifyPin("4821", stored)).toBe(true);
    expect(await verifyPin("0000", stored)).toBe(false);
    expect(await verifyPin("4821", "not-a-phc-string")).toBe(false);
  });

  it("the parameters equal the backend hasher's source", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../backend/src/infrastructure/auth/PasswordHasher.ts"),
      "utf8",
    );
    expect(source).toMatch(/memoryCost: 65536/);
    expect(source).toMatch(/timeCost: 3/);
    expect(source).toMatch(/parallelism: 4/);
    expect(source).toMatch(/algorithm: 2/);
  });

  it("a PHC string in the shape the native module returns is accepted by the backend verifier", async () => {
    const requireFromBackend = createRequire(
      path.resolve(__dirname, "../../../backend/package.json"),
    );
    const node = requireFromBackend("@node-rs/argon2") as {
      hashRaw(pw: string, o: Record<string, unknown>): Promise<Buffer>;
      verify(hash: string, pw: string): Promise<boolean>;
    };
    const salt = Buffer.from("00112233445566778899aabbccddeeff", "hex");
    const raw = await node.hashRaw("1234", {
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 4,
      algorithm: 2,
      salt,
    });
    const b64 = (b: Buffer) => b.toString("base64").replace(/=+$/, "");
    const phc = `$argon2id$v=19$m=65536,t=3,p=4$${b64(salt)}$${b64(raw)}`;
    expect(await node.verify(phc, "1234")).toBe(true);
    expect(await node.verify(phc, "9999")).toBe(false);
  });
});
