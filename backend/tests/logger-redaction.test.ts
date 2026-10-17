import { describe, it, expect } from "vitest";
import pino from "pino";
import { Writable } from "node:stream";
import { LOG_REDACT_PATHS } from "@/infrastructure/config/logger";

// SEC-02: the production logger must mask credentials wherever a call site drops them in.
describe("logger redaction (SEC-02)", () => {
  it("masks tokens, passwords and Authorization headers at the common depths", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _e, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = pino({ redact: { paths: LOG_REDACT_PATHS, censor: "***" } }, sink);
    log.error(
      {
        password: "hunter2",
        body: { refreshToken: "rt-SECRET", email: "a@b.c" },
        req: { headers: { authorization: "Bearer ya29.LIVE", host: "x" } },
        err: { message: "boom", config: { headers: { Authorization: "Bearer ya29.ERR" } } },
      },
      "failure",
    );
    const out = lines.join("");
    for (const secret of ["hunter2", "rt-SECRET", "ya29.LIVE", "ya29.ERR"])
      expect(out).not.toContain(secret);
    expect(out).toContain("a@b.c"); // non-secret fields survive
    expect(out).toContain('"host":"x"');
  });

  it("masks the desktop's own secrets too (H-07): device credential, licence token, keys, PINs", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _e, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = pino({ redact: { paths: LOG_REDACT_PATHS, censor: "***" } }, sink);
    log.warn(
      {
        deviceSecret: "DEV-SECRET",
        creds: { deviceSecret: "DEV-SECRET-2", tenantId: "t-1" },
        licence: { offline_token: "OFFLINE-TOKEN", offlineToken: "OFFLINE-2" },
        env: { APP_MASTER_KEY: "k3y-value-77", JWT_SECRET: "jw7-value-88" },
        body: { pin: "1234", newPassword: "NEWPASS" },
      },
      "diagnostic",
    );
    const out = lines.join("");
    for (const secret of [
      "DEV-SECRET",
      "OFFLINE-TOKEN",
      "OFFLINE-2",
      "k3y-value-77",
      "jw7-value-88",
      "1234",
      "NEWPASS",
    ])
      expect(out).not.toContain(secret);
    expect(out).toContain('"tenantId":"t-1"');
  });
});
