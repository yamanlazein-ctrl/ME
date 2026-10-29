import { describe, it, expect } from "vitest";
import { buildEnrollPayload, parseEnrollPayload } from "./enrollQr";

describe("enrollment QR payload", () => {
  it("round-trips the hub url and code", () => {
    const p = buildEnrollPayload("https://me-sh6t.onrender.com/", " AB12-CD34 ");
    expect(parseEnrollPayload(p)).toEqual({
      hubUrl: "https://me-sh6t.onrender.com",
      code: "AB12-CD34",
    });
  });
  it("rejects foreign or malformed QR text", () => {
    expect(parseEnrollPayload("https://example.com")).toBeNull();
    expect(parseEnrollPayload("motard-enroll://v1?u=ftp://x&c=1")).toBeNull();
    expect(parseEnrollPayload("motard-enroll://v1?u=https://x")).toBeNull();
  });
});
