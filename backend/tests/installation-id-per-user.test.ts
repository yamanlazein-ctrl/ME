/**
 * T088 / D-2 (spec FR-069): on the desktop the installation id is per WINDOWS USER (per-user data
 * root), seeded from and linked to the device-binding id; a stored value that differs from the
 * binding is reported, never overwritten. The cloud keeps its machine-level default.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopInstallationIdStorage, InstallationIdStorage, desktopDataRoot } from "@/infrastructure/installation/InstallationIdStorage.js";

const base = mkdtempSync(join(tmpdir(), "motard-install-id-"));
// two Windows users on one PC: two %LOCALAPPDATA% roots, two device bindings
const userA = join(base, "UserA", "AppData", "Local", "motard-erp");
const userB = join(base, "UserB", "AppData", "Local", "motard-erp");

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("desktop installation id is per Windows user (D-2)", () => {
  it("two users on the same PC get different ids, each stored in its own data root", async () => {
    const a = await new DesktopInstallationIdStorage(userA, "binding-user-a").readOrCreate();
    const b = await new DesktopInstallationIdStorage(userB, "binding-user-b").readOrCreate();
    expect(a).toBe("binding-user-a");
    expect(b).toBe("binding-user-b");
    expect(a).not.toBe(b);
    expect(readFileSync(join(userA, "install-id"), "utf8")).toBe("binding-user-a");
    expect(readFileSync(join(userB, "install-id"), "utf8")).toBe("binding-user-b");
  });

  it("is stable across restarts for the same user", async () => {
    expect(await new DesktopInstallationIdStorage(userA, "binding-user-a").readOrCreate()).toBe("binding-user-a");
  });

  it("a stored id that differs from the device binding is reported and NOT overwritten", async () => {
    const root = join(base, "Copied", "motard-erp");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "install-id"), "someone-elses-id");
    await expect(new DesktopInstallationIdStorage(root, "this-device-binding").readOrCreate()).rejects.toMatchObject({ code: "INSTALLATION_ID_MISMATCH" });
    expect(readFileSync(join(root, "install-id"), "utf8")).toBe("someone-elses-id");
  });

  it("the data root is derived from SQLITE_PATH (<root>\\data\\motard.db)", () => {
    expect(desktopDataRoot(join(userA, "data", "motard.db"))).toBe(userA);
  });

  it("the cloud default stays machine-level (unchanged)", () => {
    const cloud = new InstallationIdStorage() as unknown as { filePath: string };
    expect(cloud.filePath).not.toContain("motard-erp");
  });
});
