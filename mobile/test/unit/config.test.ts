import { describe, expect, it, vi } from "vitest";

vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "1.2.3" } } }));

import { buildConfig } from "../../src/core/config";
import { applyPhoneConfig, config } from "../../src/platform/envConfig";

// The fields the bundled desktop code reads from `config` (evidence/T045-ports.md).
const FIELDS = [
  "DB_ENGINE",
  "DESKTOP_DEPLOY",
  "NUMBER_BLOCKS_ENABLED",
  "CENTRAL_SYNC_URL",
  "APP_MASTER_KEY",
] as const;

describe("phone configuration", () => {
  it("envConfig has every field listed in T045 with the phone's values", () => {
    for (const field of FIELDS) expect(field in config, field).toBe(true);
    expect(config.DB_ENGINE).toBe("sqlite");
    expect(config.DESKTOP_DEPLOY).toBe(true);
    expect(config.NUMBER_BLOCKS_ENABLED).toBe(true);
    expect(config.APP_MASTER_KEY.length).toBeGreaterThanOrEqual(32);
  });

  it("applyPhoneConfig sets the hub url after enrolment", () => {
    applyPhoneConfig({ CENTRAL_SYNC_URL: "https://hub.example" });
    expect(config.CENTRAL_SYNC_URL).toBe("https://hub.example");
  });

  it("buildConfig returns a frozen object with deviceKind phone and the app version", () => {
    const c = buildConfig({ hubUrl: "https://hub.example/", tenantId: "t", syncDeviceId: "d" });
    expect(c).toEqual({
      hubUrl: "https://hub.example",
      tenantId: "t",
      syncDeviceId: "d",
      deviceKind: "phone",
      appVersion: "1.2.3",
    });
    expect(Object.isFrozen(c)).toBe(true);
  });
});
