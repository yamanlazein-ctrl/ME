/**
 * BC-5: GET /api/mobile/version answers the version manifest without authentication, or 404
 * MOBILE_VERSION_NOT_CONFIGURED when the environment is not set.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import { MONEY_RULES_VERSION } from "@erp/shared";
import {
  readMobileVersionManifest,
  registerMobileVersionRoute,
} from "../src/presentation/routes/mobileVersion.route.js";

const SHA = "a".repeat(64);
const configured = {
  MOBILE_MIN_VERSION_CODE: "3",
  MOBILE_LATEST_VERSION_CODE: "5",
  MOBILE_LATEST_VERSION_NAME: "1.2.0",
  MOBILE_APK_URL: "https://hub.example/apk/motard-1.2.0.apk",
  MOBILE_APK_SHA256: SHA,
};

async function get(env: Record<string, string | undefined>) {
  const app = express();
  const router = express.Router();
  registerMobileVersionRoute(router, env);
  app.use(router);
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/mobile/version`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

describe("mobile version manifest (BC-5)", () => {
  it("answers the manifest with the money-rules version, with no authentication header", async () => {
    const r = await get(configured);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      minVersionCode: 3,
      latestVersionCode: 5,
      latestVersionName: "1.2.0",
      apkUrl: configured.MOBILE_APK_URL,
      apkSha256: SHA,
      moneyRulesVersion: MONEY_RULES_VERSION,
    });
  });

  it("answers 404 MOBILE_VERSION_NOT_CONFIGURED when nothing is set", async () => {
    const r = await get({});
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("MOBILE_VERSION_NOT_CONFIGURED");
  });

  it("treats a malformed or incomplete environment as not configured", () => {
    expect(readMobileVersionManifest({ ...configured, MOBILE_APK_SHA256: "xyz" })).toBeNull();
    expect(
      readMobileVersionManifest({ ...configured, MOBILE_LATEST_VERSION_CODE: "2" }),
    ).toBeNull();
    expect(readMobileVersionManifest({ ...configured, MOBILE_APK_URL: "" })).toBeNull();
    expect(readMobileVersionManifest({ ...configured, MOBILE_MIN_VERSION_CODE: "a" })).toBeNull();
    expect(readMobileVersionManifest(configured)).not.toBeNull();
  });

  it("is registered in server.ts next to the health routes", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/presentation/server.ts"), "utf8");
    const health = src.indexOf("registerHealthRoutes(router");
    const version = src.indexOf("registerMobileVersionRoute(router");
    expect(health).toBeGreaterThan(-1);
    expect(version).toBeGreaterThan(health);
    expect(version - health).toBeLessThan(600);
  });
});
