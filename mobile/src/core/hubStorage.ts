// Where the shared hubConfig keeps its small "files" (hub URL, session tokens, encrypted device credential).
// On the phone they are virtual paths backed by Keystore-protected secure storage (platform/hubFs.ts).
import { hydrateHubFs } from "../platform/hubFs";

export const HUB_PATHS = {
  config: "/motard/hub.json",
  session: "/motard/hub-session.json",
  credentials: "/motard/hub-credentials.dat",
} as const;

export function pointHubConfigAt(paths: { config: string; session: string; credentials: string }) {
  process.env.HUB_CONFIG_PATH = paths.config;
  process.env.HUB_SESSION_PATH = paths.session;
  process.env.HUB_CREDENTIALS_PATH = paths.credentials;
}

/** Call once at start-up, before the sync loop: points hubConfig at the virtual files and loads their contents. */
export async function initHubStorage(): Promise<void> {
  pointHubConfigAt(HUB_PATHS);
  await hydrateHubFs(Object.values(HUB_PATHS));
}
