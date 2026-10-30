// Where the app should be, from three facts (FR-06, FR-07, FR-01). Pure so it can be tested; the root layout calls it.
export interface GuardInput {
  enrolled: boolean;
  /** The first download (FR-07) finished. */
  firstDownloadDone: boolean;
  signedIn: boolean;
}

export type GuardTarget = "/enroll" | "/login" | "/(tabs)";

export function routeFor({ enrolled, firstDownloadDone, signedIn }: GuardInput): GuardTarget {
  if (!enrolled) return "/enroll";
  if (!firstDownloadDone) return "/enroll"; // the enrol screen shows the unfinished download's progress
  if (!signedIn) return "/login";
  return "/(tabs)";
}

/** True when `current` (a path such as "/enroll" or "/(tabs)/parties") already is where the guard wants the user. */
export function isAllowedHere(current: string, target: GuardTarget): boolean {
  if (target === "/(tabs)") return !["/enroll", "/login"].includes(current);
  return current === target;
}
