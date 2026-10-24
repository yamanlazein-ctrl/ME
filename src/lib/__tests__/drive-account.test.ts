import { describe, it, expect } from "vitest";
import { driveAccountView, showAdvancedClientForm } from "@/lib/drive-account";
import type { GoogleShellStatus } from "@/lib/drive-archive";

const base: GoogleShellStatus = {
  connected: false,
  configured: true,
  source: "bundled",
  email: null,
  scopes: "",
};

describe("driveAccountView", () => {
  it("is null before the shell has answered", () => {
    expect(driveAccountView(undefined)).toBeNull();
  });

  it("offers one-click connect when a client is available and nothing is linked", () => {
    expect(driveAccountView(base)).toEqual({ kind: "connect", canConnect: true });
  });

  it("shows the connected account email and source", () => {
    const v = driveAccountView({
      ...base,
      connected: true,
      email: "user@gmail.com",
      scopes: "x",
    });
    expect(v).toEqual({ kind: "connected", email: "user@gmail.com", source: "bundled" });
  });

  it("reports unavailable when neither a bundled nor an override client exists", () => {
    expect(driveAccountView({ ...base, configured: false, source: null })).toEqual({
      kind: "unavailable",
    });
  });

  it("treats an empty email as unknown, not as an empty string", () => {
    const v = driveAccountView({ ...base, connected: true, email: "" });
    expect(v).toEqual({ kind: "connected", email: null, source: "bundled" });
  });
});

describe("showAdvancedClientForm", () => {
  it("is hidden for a regular install with a bundled client", () => {
    expect(showAdvancedClientForm(base)).toBe(false);
  });

  it("is shown when no client is available at all", () => {
    expect(showAdvancedClientForm({ ...base, configured: false, source: null })).toBe(true);
  });

  it("is shown while an admin override is in effect", () => {
    expect(showAdvancedClientForm({ ...base, source: "override" })).toBe(true);
  });

  it("is hidden until the shell has answered", () => {
    expect(showAdvancedClientForm(undefined)).toBe(false);
  });
});
