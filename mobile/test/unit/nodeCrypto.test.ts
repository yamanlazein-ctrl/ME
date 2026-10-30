import { describe, expect, it } from "vitest";
import { createHash as nodeCreateHash } from "node:crypto";
import {
  createHash,
  randomBytes,
  randomUUID,
  setUuidSequenceForSpike,
  timingSafeEqual,
} from "../../src/platform/nodeCrypto";

describe("nodeCrypto adapter", () => {
  it("sha256 matches Node for known and long inputs", () => {
    for (const input of [
      "motard",
      "",
      "x".repeat(55),
      "x".repeat(56),
      "x".repeat(64),
      "تجربة".repeat(100),
    ]) {
      const expected = nodeCreateHash("sha256").update(input, "utf8").digest("hex");
      expect(createHash("sha256").update(input, "utf8").digest("hex")).toBe(expected);
      expect(createHash("sha256").update(input).digest("base64")).toBe(
        nodeCreateHash("sha256").update(input).digest("base64"),
      );
    }
    expect(createHash("sha256").update("").digest("hex")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("update can be chained and digest() returns a Buffer", () => {
    const h = createHash("sha256").update("mot").update("ard").digest();
    expect(h.toString("hex")).toBe(nodeCreateHash("sha256").update("motard").digest("hex"));
  });

  it("randomUUID is v4-shaped; the spike sequence is deterministic and v4-shaped", () => {
    const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(randomUUID()).toMatch(v4);
    setUuidSequenceForSpike("s2");
    const a = [randomUUID(), randomUUID()];
    setUuidSequenceForSpike("s2");
    const b = [randomUUID(), randomUUID()];
    expect(a).toEqual(b);
    expect(a[0]).not.toBe(a[1]);
    expect(a[0]).toMatch(v4);
  });

  it("randomBytes and timingSafeEqual", () => {
    expect(randomBytes(12)).toHaveLength(12);
    expect(randomBytes(32).toString("base64url")).toHaveLength(43);
    expect(timingSafeEqual(Buffer.from("ab"), Buffer.from("ab"))).toBe(true);
    expect(timingSafeEqual(Buffer.from("ab"), Buffer.from("ac"))).toBe(false);
    expect(() => timingSafeEqual(Buffer.from("a"), Buffer.from("ab"))).toThrow();
  });
});
