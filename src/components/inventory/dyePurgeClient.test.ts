import { describe, it, expect } from "vitest";
import { isHubOnlyPurgeError } from "./dyePurgeClient";
import { ConflictError, mapHttpStatusToDomainError } from "@/core/errors/DomainError";

describe("isHubOnlyPurgeError", () => {
  it("matches the SYNC_DEVICES_ENROLLED 409, whatever the message wording", () => {
    const err = mapHttpStatusToDomainError(
      409,
      { code: "SYNC_DEVICES_ENROLLED", message: "x" },
      "any wording",
    );
    expect(err).toBeInstanceOf(ConflictError);
    expect(isHubOnlyPurgeError(err)).toBe(true);
  });
  it("ignores other conflicts and plain errors", () => {
    expect(
      isHubOnlyPurgeError(mapHttpStatusToDomainError(409, { code: "PURGE_FAILED" }, "m")),
    ).toBe(false);
    expect(isHubOnlyPurgeError(mapHttpStatusToDomainError(409, null, "m"))).toBe(false);
    expect(isHubOnlyPurgeError(new Error("الحذف التصحيحي لا يُزامَن"))).toBe(false);
    expect(isHubOnlyPurgeError("x")).toBe(false);
  });
});
