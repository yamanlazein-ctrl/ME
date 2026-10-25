// Errors are never swallowed: every failure that reaches a screen is also written to the device log under one greppable tag
// (adb logcat | grep MOTARD_ERR) and kept in a short in-memory list for the diagnostics line on screen.
const recent: string[] = [];
const MAX = 20;

export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** Logs `error` for `scope` and returns its one-line description. */
export function logError(scope: string, error: unknown): string {
  const text = describeError(error);
  const stack = error instanceof Error && error.stack ? `\n${error.stack}` : "";
  console.error(`MOTARD_ERR [${scope}] ${text}${stack}`);
  recent.unshift(`${scope}: ${text}`);
  recent.length = Math.min(recent.length, MAX);
  return text;
}

export function recentErrors(): readonly string[] {
  return recent;
}
