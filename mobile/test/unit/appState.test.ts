import { beforeEach, describe, expect, it, vi } from "vitest";

const files = new Map<string, string>();
const calls: string[] = [];
vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///data/",
  getInfoAsync: vi.fn(async (uri: string) => ({ exists: files.has(uri) })),
  readAsStringAsync: vi.fn(async (uri: string) => files.get(uri) ?? ""),
  writeAsStringAsync: vi.fn(async (uri: string, text: string) => {
    calls.push(`write ${uri}`);
    files.set(uri, text);
  }),
  moveAsync: vi.fn(async ({ from, to }: { from: string; to: string }) => {
    calls.push(`move ${from} -> ${to}`);
    files.set(to, files.get(from) ?? "");
    files.delete(from);
  }),
}));

import {
  DEFAULT_APP_STATE,
  readAppState,
  updateAppState,
  withRecentParty,
  writeAppState,
} from "../../src/core/appState";

beforeEach(() => {
  files.clear();
  calls.length = 0;
});

describe("appState", () => {
  it("returns the defaults when the file is missing or corrupt", async () => {
    expect(await readAppState()).toEqual(DEFAULT_APP_STATE);
    files.set("file:///data/app-state.json", "{not json");
    expect(await readAppState()).toEqual(DEFAULT_APP_STATE);
    expect(DEFAULT_APP_STATE.appLockEnabled).toBe(true);
  });

  it("writes atomically: temp file first, then move over the real one", async () => {
    await writeAppState({ ...DEFAULT_APP_STATE, updateChannel: "play" });
    expect(calls).toEqual([
      "write file:///data/app-state.json.tmp",
      "move file:///data/app-state.json.tmp -> file:///data/app-state.json",
    ]);
    expect((await readAppState()).updateChannel).toBe("play");
    expect(files.has("file:///data/app-state.json.tmp")).toBe(false);
  });

  it("merges patches and keeps at most 50 recent parties without duplicates", async () => {
    let state = DEFAULT_APP_STATE;
    for (let i = 0; i < 60; i++) state = withRecentParty(state, `p${i}`);
    state = withRecentParty(state, "p10");
    expect(state.recentPartyIds).toHaveLength(50);
    expect(state.recentPartyIds[0]).toBe("p10");
    expect(new Set(state.recentPartyIds).size).toBe(50);
    await writeAppState(state);
    const patched = await updateAppState({ lastForegroundAt: "2026-10-25T10:00:00.000Z" });
    expect(patched.lastForegroundAt).toBe("2026-10-25T10:00:00.000Z");
    expect(patched.recentPartyIds[0]).toBe("p10");
  });
});
