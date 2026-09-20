/**
 * Phase 2 — shared activation error → HTTP status mapping.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  mapActivationError,
  mapActivationFailure,
} from "../src/domain/licensing/activationHttpStatus.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("mapActivationError (Phase 2)", () => {
  it("maps known license codes to stable HTTP statuses", () => {
    expect(mapActivationError("INVALID_LICENSE").status).toBe(400);
    expect(mapActivationError("ALREADY_ACTIVE").status).toBe(409);
    expect(mapActivationError("LICENSE_SUSPENDED").status).toBe(403);
    expect(mapActivationError("LICENSE_REVOKED").status).toBe(403);
    expect(mapActivationError("DEVICE_LIMIT").status).toBe(409);
    expect(mapActivationError("DEVICE_LIMIT_REACHED").status).toBe(409);
    expect(mapActivationError("FINGERPRINT_MISMATCH").status).toBe(409);
  });

  it("defaults unknown errors to 500 with safe message", () => {
    const r = mapActivationError(new Error("weird-db-blowup"));
    expect(r.status).toBe(500);
    expect(r.code).toBe("weird-db-blowup");
    expect(r.message).toBe("فشل التفعيل");
  });

  it("treats empty as ACTIVATION_FAILED 400", () => {
    const r = mapActivationError("");
    expect(r.status).toBe(400);
    expect(r.code).toBe("ACTIVATION_FAILED");
  });

  it("mapActivationFailure prefers machine code for status and human error for message", () => {
    const r = mapActivationFailure({
      code: "ALREADY_ACTIVE",
      error: "الترخيص مفعّل حالياً على جهاز آخر",
    });
    expect(r.status).toBe(409);
    expect(r.code).toBe("ALREADY_ACTIVE");
    expect(r.message).toBe("الترخيص مفعّل حالياً على جهاز آخر");
  });

  it("mapActivationFailure without code stays ACTIVATION_FAILED 400", () => {
    const r = mapActivationFailure({ error: "بيانات التفعيل غير صالحة" });
    expect(r.status).toBe(400);
    expect(r.code).toBe("ACTIVATION_FAILED");
    expect(r.message).toBe("بيانات التفعيل غير صالحة");
  });
});

describe("activation routes use the shared mapper (Phase 2)", () => {
  it("license-v1 activate catch uses mapActivationError", () => {
    const src = readFileSync(
      resolve(HERE, "../src/scripts/license-v1.route.ts"),
      "utf8",
    );
    expect(src).toMatch(/from ["'].*activationHttpStatus\.js["']/);
    expect(src).toMatch(/mapActivationError\(/);
    expect(src).not.toMatch(/msg === "INVALID_LICENSE" \? 400/);
  });

  it("setup wizard activate uses mapActivationFailure with r.code", () => {
    const src = readFileSync(
      resolve(HERE, "../src/presentation/routes/setup.route.ts"),
      "utf8",
    );
    expect(src).toMatch(/from ["'].*activationHttpStatus\.js["']/);
    expect(src).toMatch(/mapActivationFailure\(\s*\{\s*code:\s*r\.code/);
    expect(src).not.toMatch(/ACTIVATION_FAILED", message: r\.error/);
  });
});
