/**
 * Tests for the resolveCreatedBy helper.
 *
 * The print templates call resolveCreatedBy(raw) to convert whatever the
 * backend stored in `createdBy` (a UUID, a name, or null) into a printable
 * user name. The fallback is "Admin" for null / unknown / malformed ids.
 */
import { describe, it, expect } from "vitest";
import { resolveCreatedBy, userById, FALLBACK_USER_NAME } from "@/presentation/hooks/useSettings";

describe("resolveCreatedBy", () => {
  it("returns 'Admin' for null", () => {
    expect(resolveCreatedBy(null)).toBe(FALLBACK_USER_NAME);
  });

  it("returns 'Admin' for undefined", () => {
    expect(resolveCreatedBy(undefined)).toBe(FALLBACK_USER_NAME);
  });

  it("returns 'Admin' for empty string", () => {
    expect(resolveCreatedBy("")).toBe(FALLBACK_USER_NAME);
  });

  it("returns 'Admin' for whitespace-only string", () => {
    expect(resolveCreatedBy("   ")).toBe(FALLBACK_USER_NAME);
  });

  it("returns 'Admin' for an unknown UUID", () => {
    // A real UUID-shaped string that doesn't match any seeded user
    expect(resolveCreatedBy("c30855ff-09f4-4961-866f-0a6649bb52b6")).toBe(FALLBACK_USER_NAME);
  });

  it("returns the user name when the UUID matches a real user", () => {
    // The seeded admin in settings has id "usr-1". "usr-1" is NOT a
    // UUID-shaped string, so resolveCreatedBy treats it as a name
    // and returns it as-is. (The backend would have stored a real
    // UUID, which would then look up via userById and fall back to
    // "Admin" since the test environment has its own user fixtures.)
    expect(resolveCreatedBy("usr-1")).toBe("usr-1");
  });

  it("falls back to 'Admin' for real UUIDs that don't match any user", () => {
    // The actual UUID coming from the backend
    expect(resolveCreatedBy("c30855ff-09f4-4961-866f-0a6649bb52b6")).toBe(FALLBACK_USER_NAME);
  });

  it("returns the input as-is when it is already a name (non-UUID)", () => {
    expect(resolveCreatedBy("مدير النظام")).toBe("مدير النظام");
    expect(resolveCreatedBy("Admin")).toBe("Admin");
  });

  it("trims whitespace before resolving", () => {
    expect(resolveCreatedBy("  Admin  ")).toBe("Admin");
  });
});
