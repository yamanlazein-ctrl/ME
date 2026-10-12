/**
 * C1-12 — the settings area is admin-only, deny-by-default, consistent with the role map and with the
 * backend (every settings write is rbac(["admin"])). Owner decision 2026-10-12: the accountant holds
 * every admin privilege (rbac admits it wherever "admin" is allowed). Source contract: the layout
 * renders the outlet only for admin/accountant, and nothing (a check / a denial) while the role is
 * unknown.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { roleCanAccess } from "@/presentation/hooks/useSettings";

const layout = readFileSync(join(__dirname, "settings.tsx"), "utf8");

describe("settings access", () => {
  it("the role map grants /settings to admin and accountant only", () => {
    for (const role of ["warehouse", "viewer"] as const) {
      for (const p of [
        "/settings",
        "/settings/company",
        "/settings/users",
        "/settings/activity",
        "/settings/backup",
      ]) {
        expect(roleCanAccess(role, p), `${role} ${p}`).toBe(false);
      }
    }
    for (const role of ["admin", "accountant"] as const) {
      expect(roleCanAccess(role, "/settings/company")).toBe(true);
      expect(roleCanAccess(role, "/inventory")).toBe(true);
    }
  });

  it("the layout denies before rendering any settings page", () => {
    const guard = layout.indexOf("if (!me || !hasAdminPrivileges(me.role))");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(layout.indexOf("<Outlet />"));
    expect(layout).toContain('role="alert"');
  });
});
