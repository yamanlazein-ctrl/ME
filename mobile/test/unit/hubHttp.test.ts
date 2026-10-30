import { describe, expect, it, vi } from "vitest";
import { MONEY_RULES_VERSION } from "@erp/shared";
import {
  DeviceRevokedError,
  UnknownDeviceError,
  VersionMismatchError,
  classifyHubFailure,
  createHubFetch,
  type HubSignal,
} from "../../src/core/hubHttp";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("hubHttp", () => {
  it("adds X-Motard-Money-Version to push and pull only", async () => {
    const base = vi.fn(async () => json(200, {}));
    const hubFetch = createHubFetch(base as unknown as typeof fetch);
    await hubFetch("https://hub.example/api/sync/push", { method: "POST" });
    await hubFetch("https://hub.example/api/sync/pull?afterSeq=0");
    await hubFetch("https://hub.example/api/sync/status");
    const sent = base.mock.calls.map((c) =>
      new Headers((c as unknown as [string, RequestInit])[1]?.headers).get(
        "x-motard-money-version",
      ),
    );
    expect(sent).toEqual([String(MONEY_RULES_VERSION), String(MONEY_RULES_VERSION), null]);
  });

  it("maps 426 / 403 / 403 to the three typed errors", () => {
    expect(
      classifyHubFailure(426, { code: "SYNC_VERSION_MISMATCH", hubVersion: 1, clientVersion: 2 }),
    ).toBeInstanceOf(VersionMismatchError);
    expect(classifyHubFailure(403, { code: "SYNC_DEVICE_REVOKED" })).toBeInstanceOf(
      DeviceRevokedError,
    );
    expect(classifyHubFailure(403, { code: "SYNC_UNKNOWN_DEVICE" })).toBeInstanceOf(
      UnknownDeviceError,
    );
    expect(classifyHubFailure(403, { code: "FORBIDDEN" })).toBeNull();
    expect(classifyHubFailure(500, null)).toBeNull();
    const err = classifyHubFailure(426, {
      code: "SYNC_VERSION_MISMATCH",
      hubVersion: 2,
      clientVersion: 1,
    });
    expect(err).toMatchObject({ hubVersion: 2, clientVersion: 1 });
  });

  it("reports the signals while returning the response untouched", async () => {
    const signals: HubSignal[] = [];
    const answers = [
      json(426, { code: "SYNC_VERSION_MISMATCH", hubVersion: 2, clientVersion: 1 }),
      json(403, { code: "SYNC_DEVICE_REVOKED" }),
      json(403, { code: "SYNC_UNKNOWN_DEVICE" }),
      json(200, {}, { date: "Sun, 25 Oct 2026 10:00:00 GMT" }),
    ];
    const hubFetch = createHubFetch((async () => answers.shift()) as unknown as typeof fetch, (s) =>
      signals.push(s),
    );
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await hubFetch("https://hub/api/sync/push")).status);
    expect(statuses).toEqual([426, 403, 403, 200]);
    expect(signals.map((s) => s.kind)).toEqual([
      "versionMismatch",
      "revoked",
      "unknownDevice",
      "serverDate",
    ]);
  });
});
