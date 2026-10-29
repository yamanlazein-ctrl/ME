import { describe, expect, it } from "vitest";
import { installBuffer } from "../../src/platform/bufferPolyfill";

const B = installBuffer();

describe("Buffer polyfill for Hermes", () => {
  it("round-trips base64url like Node, for keyset cursors", () => {
    const json = JSON.stringify({ sortKey: "عميل ؟>", id: "a-b" });
    const poly = B.from(json, "utf8").toString("base64url" as never);
    const node = Buffer.from(json, "utf8").toString("base64url");
    expect(poly).toBe(node);
    expect(B.from(poly, "base64url" as never).toString("utf8")).toBe(json);
  });
  it("compares bytes and supports hex / base64 like Node", () => {
    expect(B.compare(B.from("a", "utf8"), B.from("b", "utf8"))).toBe(-1);
    expect(B.from("zz", "utf8").toString("hex")).toBe(Buffer.from("zz").toString("hex"));
    expect(B.from("aGk=", "base64").toString("utf8")).toBe("hi");
  });
  it("installs a global Buffer when none exists", () => {
    expect(typeof (globalThis as { Buffer?: unknown }).Buffer).toBe("function");
  });
});
