// app-state.json: the few phone-only settings that are not secrets (data-model.md). One JSON file in the app's private
// documents directory. Writes are atomic: write a temp file, then move it over the real one.
import * as FileSystem from "expo-file-system/legacy";

export interface AppState {
  appLockEnabled: boolean;
  /** The desktop's default is the dark theme. */
  theme: "dark" | "light";
  /** ISO timestamp of the last time the app was in the foreground, or null. */
  lastForegroundAt: string | null;
  updateChannel: "play" | "apk";
  lastVersionCheckAt: string | null;
  /** Party ids, most recent first, at most 50 (tasks T087). */
  recentPartyIds: string[];
}

export const APP_STATE_FILE = "app-state.json";
export const MAX_RECENT_PARTIES = 50;

export const DEFAULT_APP_STATE: AppState = {
  appLockEnabled: true,
  theme: "dark",
  lastForegroundAt: null,
  updateChannel: "apk",
  lastVersionCheckAt: null,
  recentPartyIds: [],
};

function target(): string {
  const dir = FileSystem.documentDirectory;
  if (!dir) throw new Error("documentDirectory is unavailable");
  return `${dir}${APP_STATE_FILE}`;
}

function normalize(value: unknown): AppState {
  const v = (value ?? {}) as Partial<AppState>;
  return {
    appLockEnabled: typeof v.appLockEnabled === "boolean" ? v.appLockEnabled : true,
    theme: v.theme === "light" ? "light" : "dark",
    lastForegroundAt: typeof v.lastForegroundAt === "string" ? v.lastForegroundAt : null,
    updateChannel: v.updateChannel === "play" ? "play" : "apk",
    lastVersionCheckAt: typeof v.lastVersionCheckAt === "string" ? v.lastVersionCheckAt : null,
    recentPartyIds: Array.isArray(v.recentPartyIds)
      ? v.recentPartyIds
          .filter((id): id is string => typeof id === "string")
          .slice(0, MAX_RECENT_PARTIES)
      : [],
  };
}

export async function readAppState(): Promise<AppState> {
  const file = target();
  const info = await FileSystem.getInfoAsync(file);
  if (!info.exists) return { ...DEFAULT_APP_STATE };
  try {
    return normalize(JSON.parse(await FileSystem.readAsStringAsync(file)));
  } catch {
    return { ...DEFAULT_APP_STATE };
  }
}

export async function writeAppState(state: AppState): Promise<void> {
  const file = target();
  const temp = `${file}.tmp`;
  await FileSystem.writeAsStringAsync(temp, JSON.stringify(normalize(state)));
  await FileSystem.moveAsync({ from: temp, to: file });
}

export async function updateAppState(patch: Partial<AppState>): Promise<AppState> {
  const next = normalize({ ...(await readAppState()), ...patch });
  await writeAppState(next);
  return next;
}

/** Moves a party to the front of the recent list (max 50, no duplicates). */
export function withRecentParty(state: AppState, partyId: string): AppState {
  return {
    ...state,
    recentPartyIds: [partyId, ...state.recentPartyIds.filter((id) => id !== partyId)].slice(
      0,
      MAX_RECENT_PARTIES,
    ),
  };
}
