import { describe, expect, it } from "vitest";
import { isAllowedHere, routeFor } from "../../src/core/routeGuard";
import {
  canWriteOffline,
  currentRole,
  isAdmin,
  isAdminLike,
  type Role,
} from "../../src/core/roles";

describe("routeGuard (T065)", () => {
  it("not enrolled → /enroll", () => {
    expect(routeFor({ enrolled: false, firstDownloadDone: false, signedIn: false })).toBe(
      "/enroll",
    );
  });
  it("enrolled with an unfinished first download → the progress screen (/enroll)", () => {
    expect(routeFor({ enrolled: true, firstDownloadDone: false, signedIn: false })).toBe("/enroll");
  });
  it("enrolled, downloaded, not signed in → /login; signed in → tabs", () => {
    expect(routeFor({ enrolled: true, firstDownloadDone: true, signedIn: false })).toBe("/login");
    expect(routeFor({ enrolled: true, firstDownloadDone: true, signedIn: true })).toBe("/(tabs)");
  });
  it("knows when the current path already satisfies the target", () => {
    expect(isAllowedHere("/enroll", "/enroll")).toBe(true);
    expect(isAllowedHere("/parties", "/(tabs)")).toBe(true);
    expect(isAllowedHere("/login", "/(tabs)")).toBe(false);
  });
});

describe("roles (T071, constitution VI)", () => {
  const roles: Role[] = ["admin", "accountant", "warehouse", "viewer"];
  it("only admin and accountant write offline", () => {
    expect(roles.map(canWriteOffline)).toEqual([true, true, false, false]);
  });
  it("the accountant holds every admin privilege; strict admin is only the admin", () => {
    expect(roles.map(isAdminLike)).toEqual([true, true, false, false]);
    expect(roles.map(isAdmin)).toEqual([true, false, false, false]);
  });
  it("the role is read on every check, so a role change applies at once (E18)", async () => {
    let stored: Role | null = "admin";
    const read = async () => stored;
    expect(canWriteOffline(await currentRole(read, "u1"))).toBe(true);
    stored = "viewer";
    expect(canWriteOffline(await currentRole(read, "u1"))).toBe(false);
    stored = null;
    expect(await currentRole(read, "u1")).toBe("viewer"); // unknown user = least privilege
  });
});
