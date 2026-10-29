import { describe, expect, it } from "vitest";
import {
  canWriteOffline,
  currentRole,
  isAdmin,
  isAdminLike,
  type Role,
} from "../../src/core/roles";

describe("roles (FR-05, constitution VI)", () => {
  const table: Array<[Role, boolean, boolean, boolean]> = [
    ["admin", true, true, true],
    ["accountant", true, true, false],
    ["warehouse", false, false, false],
    ["viewer", false, false, false],
  ];
  it.each(table)("%s: write=%s adminLike=%s admin=%s", (role, write, adminLike, admin) => {
    expect(canWriteOffline(role)).toBe(write);
    expect(isAdminLike(role)).toBe(adminLike);
    expect(isAdmin(role)).toBe(admin);
  });

  it("reads the stored role on every call (a role pulled from the hub applies at once, E18)", async () => {
    let stored: Role | null = "accountant";
    const read = async () => stored;
    expect(await currentRole(read, "u1")).toBe("accountant");
    stored = "viewer";
    expect(await currentRole(read, "u1")).toBe("viewer");
    stored = null;
    expect(await currentRole(read, "u1")).toBe("viewer");
  });
});
