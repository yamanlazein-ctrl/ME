import { describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { userFacingErrors } from "@/infrastructure/http/middleware/userFacingErrors.middleware.js";

/** Runs the middleware on a fake response and returns what `res.json` finally sends. */
function send(status: number, body: unknown): unknown {
  let sent: unknown;
  const res = { statusCode: status, json: (b: unknown) => ((sent = b), res) } as unknown as Response;
  userFacingErrors({ path: "/x", method: "POST" } as Request, res, () => {});
  res.json(body);
  return sent;
}

describe("userFacingErrors — SQL never reaches the user", () => {
  const sqlText = 'Failed query: update "parties" set "name" = ? where "id" = ? params: abc';

  it("replaces technical text by kind of failure", () => {
    expect(send(500, { code: "X", message: sqlText })).toMatchObject({ code: "DATABASE_ERROR" });
    expect(send(409, { code: "X", message: sqlText })).toMatchObject({ code: "SYNC_CONFLICT" });
    expect(send(503, { code: "X", message: sqlText })).toMatchObject({ code: "SERVER_UNAVAILABLE" });
    expect(JSON.stringify(send(500, { message: sqlText }))).not.toMatch(/parties|Failed query/);
  });

  it("passes business messages and successful bodies through untouched", () => {
    const business = { code: "VALIDATION", message: "اكتب سبب التعديل" };
    expect(send(422, business)).toBe(business);
    const ok = { message: sqlText };
    expect(send(200, ok)).toBe(ok);
  });
});
