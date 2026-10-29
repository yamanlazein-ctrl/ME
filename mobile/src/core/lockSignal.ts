// A fresh sign-in already proved who is holding the phone, so the app lock must not ask again right after it: the login
// screen calls `signalUnlocked()` and the root layout lifts the cover (FR-04 still applies on every cold start / resume).
const listeners = new Set<() => void>();

export function onUnlockedByLogin(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function signalUnlocked(): void {
  listeners.forEach((l) => l());
}
