/**
 * Who may replace a PIN that already exists (POST /api/auth/set-pin).
 *
 * A first PIN is set on the device's provisioning proof alone (the device opened the roster). Replacing an existing
 * PIN is different: "any live session of the tenant" used to be enough, so a viewer — or any enrolled device — could
 * set an admin's PIN and then sign in as the admin. Now one of these must hold:
 *  - the caller knows the user's current PIN or password;
 *  - the caller's own session is that user's;
 *  - the caller's session is an active admin's;
 *  - the caller is the operator at the desktop itself (lost-PIN recovery on the machine; physical access).
 */
export interface PinResetTarget {
  id: string;
  pinHash: string | null;
  passwordHash: string | null;
}

export interface PinResetDeps {
  /** The verified caller of the Bearer token (null when absent, invalid, revoked or another tenant's). */
  sessionCaller(): Promise<{ userId: string; role: string; active: boolean } | null>;
  verifySecret(hash: string, secret: string): Promise<boolean>;
  /** Desktop deployment and the request comes from this machine. */
  isLocalDesktopOperator(): boolean;
}

export async function mayReplaceExistingPin(
  target: PinResetTarget,
  currentSecret: string | undefined,
  deps: PinResetDeps,
): Promise<boolean> {
  if (deps.isLocalDesktopOperator()) return true;
  if (currentSecret) {
    for (const hash of [target.pinHash, target.passwordHash]) {
      if (hash && (await deps.verifySecret(hash, currentSecret).catch(() => false))) return true;
    }
  }
  const caller = await deps.sessionCaller().catch(() => null);
  if (!caller || !caller.active) return false;
  return caller.userId === target.id || caller.role === "admin";
}
