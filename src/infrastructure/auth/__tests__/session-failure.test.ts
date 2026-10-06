/**
 * A 403 is a permissions answer, not a session end. Treating it as one wiped
 * both tokens and dropped the operator at the login screen the first time they
 * opened a screen their role cannot manage — the reported "logs me out on its
 * own" symptom. Same for a 5xx: only a rejected credential may end a session.
 */
import { describe, it, expect } from "vitest";
import { ApiError, ForbiddenError, NetworkError, UnauthorizedError } from "@/core/errors";
import { isAuthFailure, isPermissionDenied, isSetupRequired } from "../TokenProvider";

describe("isAuthFailure", () => {
  it("ends the session only on a rejected credential", () => {
    expect(isAuthFailure(new UnauthorizedError())).toBe(true);
    expect(isAuthFailure({ code: "TOKEN_EXPIRED", statusCode: 401 })).toBe(true);
    expect(isAuthFailure({ code: "INVALID_CREDENTIALS" })).toBe(true);
    expect(isAuthFailure(new ApiError(401, "gone", { code: "UNAUTHORIZED" }))).toBe(true);
  });

  it("keeps the session on a permissions rejection", () => {
    expect(isAuthFailure(new ForbiddenError())).toBe(false);
    expect(isAuthFailure({ status: 403 })).toBe(false);
    expect(isAuthFailure(new ApiError(403, "forbidden"))).toBe(false);
  });

  it("keeps the session when the server is unreachable or failing", () => {
    expect(isAuthFailure(new NetworkError("offline"))).toBe(false);
    expect(isAuthFailure(new ApiError(500, "boom"))).toBe(false);
    expect(isAuthFailure(new ApiError(503, "maintenance"))).toBe(false);
  });
});

describe("isPermissionDenied", () => {
  it("separates a role rejection from a dead session", () => {
    expect(isPermissionDenied(new ForbiddenError())).toBe(true);
    expect(isPermissionDenied({ status: 403 })).toBe(true);
    expect(isPermissionDenied(new UnauthorizedError())).toBe(false);
    expect(isPermissionDenied(new ApiError(500, "boom"))).toBe(false);
  });
});

describe("isSetupRequired", () => {
  it("detects the install gate answer so callers stop retrying", () => {
    expect(isSetupRequired(new ApiError(503, "setup", { code: "SETUP_REQUIRED" }))).toBe(true);
    expect(isSetupRequired({ code: "SETUP_REQUIRED", statusCode: 503 })).toBe(true);
    // A genuinely transient 5xx is not a setup verdict — keep retrying it.
    expect(isSetupRequired(new ApiError(503, "down"))).toBe(false);
    expect(isSetupRequired(new NetworkError("offline"))).toBe(false);
  });
});
