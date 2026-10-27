import { describe, expect, it, vi } from "vitest";
import {
  checkForUpdate,
  isCheckDue,
  offerFor,
  type VersionManifest,
} from "../../src/core/updateCheck";

const manifest: VersionManifest = {
  minVersionCode: 3,
  latestVersionCode: 5,
  latestVersionName: "1.2.0",
  apkUrl: "https://hub.example/a.apk",
  apkSha256: "a".repeat(64),
  moneyRulesVersion: 1,
};
const now = new Date("2026-03-10T12:00:00Z");
const json = (status: number, body: unknown) =>
  vi.fn(async () => ({ status, ok: status < 400, json: async () => body }) as Response);

describe("update check (FR-43)", () => {
  it("offers the download only when the latest version is greater than this build", () => {
    expect(offerFor(manifest, 5)).toBeNull();
    expect(offerFor(manifest, 6)).toBeNull();
    expect(offerFor(manifest, 4)).toMatchObject({ versionName: "1.2.0", required: false });
    expect(offerFor(manifest, 2)).toMatchObject({ required: true });
  });

  it("is due at most once a day", () => {
    expect(isCheckDue(null, now)).toBe(true);
    expect(isCheckDue("2026-03-10T00:00:00Z", now)).toBe(false);
    expect(isCheckDue("2026-03-09T11:59:00Z", now)).toBe(true);
    expect(isCheckDue("not a date", now)).toBe(true);
    expect(isCheckDue("2026-03-11T00:00:00Z", now)).toBe(true); // clock moved back
  });

  const base = {
    channel: "apk" as const,
    hubUrl: "https://hub.example/",
    currentVersionCode: 4,
    lastCheckAt: null,
  };

  it("asks the hub manifest and returns the offer", async () => {
    const f = json(200, manifest);
    const r = await checkForUpdate(base, { fetch: f as never, now: () => now });
    expect(r).toMatchObject({ checked: true, offer: { versionName: "1.2.0" } });
    expect(f).toHaveBeenCalledWith("https://hub.example/api/mobile/version");
  });

  it("does not ask on the Play channel, without a hub, or when not due", async () => {
    const f = json(200, manifest);
    const deps = { fetch: f as never, now: () => now };
    expect(await checkForUpdate({ ...base, channel: "play" }, deps)).toEqual({
      checked: false,
      offer: null,
    });
    expect(await checkForUpdate({ ...base, hubUrl: "" }, deps)).toEqual({
      checked: false,
      offer: null,
    });
    expect(await checkForUpdate({ ...base, lastCheckAt: "2026-03-10T08:00:00Z" }, deps)).toEqual({
      checked: false,
      offer: null,
    });
    expect(f).not.toHaveBeenCalled();
  });

  it("treats 404 as an answer, and a network or format failure as silent", async () => {
    const d = (f: unknown) => ({ fetch: f as never, now: () => now });
    expect(await checkForUpdate(base, d(json(404, {})))).toEqual({ checked: true, offer: null });
    expect(await checkForUpdate(base, d(json(500, {})))).toEqual({ checked: false, offer: null });
    expect(await checkForUpdate(base, d(json(200, { nope: 1 })))).toEqual({
      checked: false,
      offer: null,
    });
    expect(
      await checkForUpdate(base, d(vi.fn(async () => Promise.reject(new Error("offline"))))),
    ).toEqual({ checked: false, offer: null });
  });
});
