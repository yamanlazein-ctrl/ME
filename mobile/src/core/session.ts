// Sign-in, permanent session and offline PIN (FR-01..FR-05, E8, constitution VI). The session ends only on logout, a refused
// refresh (401/403 from /api/auth/refresh), revocation or a wipe - never on an ordinary 403 elsewhere, and never by time:
// the hub issues one-year tokens and the phone does not expire them on its own.
import { hashPin, verifyPin } from "../platform/pinVerifier";
import { deleteSecret, getSecret, setSecret } from "../platform/secureStore";
import type { Role } from "./roles";

export interface RosterUser {
  id: string;
  name: string;
  role: Role;
  email?: string | null;
}

export interface StoredSession {
  userId: string;
  name: string;
  role: Role;
  accessToken: string;
  refreshToken: string;
  signedInAt: string;
}

export interface SessionDeps {
  fetch: typeof fetch;
  hubUrl(): string;
  tenantId(): string;
  /** Authorization for the pre-login roster call: the device's hub session. */
  deviceAuthHeader(): Promise<string | undefined>;
  getSecret(name: string): Promise<string | null>;
  setSecret(name: string, value: string): Promise<void>;
  deleteSecret(name: string): Promise<void>;
  hashPin(pin: string): Promise<string>;
  verifyPin(pin: string, stored: string): Promise<boolean>;
  /** Units still waiting to be sent (E8). */
  pendingCount(): Promise<number>;
  now(): Date;
}

const SESSION_KEY = "session";
const ROSTER_KEY = "roster";
const pinKey = (userId: string) => `pin.${userId}`;

export class PinLoginError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid" | "network" | "offline-unavailable",
  ) {
    super(message);
    this.name = "PinLoginError";
  }
}

export function createSessionService(deps: SessionDeps) {
  const readSession = async (): Promise<StoredSession | null> => {
    const raw = await deps.getSecret(SESSION_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredSession;
    } catch {
      return null;
    }
  };
  const writeSession = (s: StoredSession) => deps.setSecret(SESSION_KEY, JSON.stringify(s));

  const endSession = async () => {
    await deps.deleteSecret(SESSION_KEY);
  };

  /** The users authorised on this device, for the PIN picker; cached after the first fetch so it works offline (FR-02). */
  async function roster(): Promise<RosterUser[]> {
    try {
      const auth = await deps.deviceAuthHeader();
      const res = await deps.fetch(
        `${deps.hubUrl()}/api/auth/device-roster?tenantId=${encodeURIComponent(deps.tenantId())}`,
        { headers: auth ? { Authorization: auth } : {} },
      );
      if (res.ok) {
        const body = (await res.json()) as { users?: RosterUser[] };
        const users = (body.users ?? []).map((u) => ({
          id: u.id,
          name: u.name,
          role: u.role,
          email: u.email ?? null,
        }));
        await deps.setSecret(ROSTER_KEY, JSON.stringify(users));
        return users;
      }
    } catch {
      // offline: fall back to the cache
    }
    const cached = await deps.getSecret(ROSTER_KEY);
    return cached ? (JSON.parse(cached) as RosterUser[]) : [];
  }

  /** Online sign-in with the user's PIN; on success the tokens and an offline verifier of the PIN are stored. */
  async function pinLogin(userId: string, pin: string): Promise<StoredSession> {
    let res: Response;
    try {
      res = await deps.fetch(`${deps.hubUrl()}/api/auth/pin-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, pin, tenantId: deps.tenantId() }),
      });
    } catch {
      throw new PinLoginError("تعذّر الاتصال بالمركز", "network");
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new PinLoginError(body.message ?? "الرمز السري غير صحيح", "invalid");
    }
    const body = (await res.json()) as {
      accessToken: string;
      refreshToken: string;
      user: { id: string; name: string; role: Role };
    };
    await deps.setSecret(pinKey(userId), await deps.hashPin(pin));
    const session: StoredSession = {
      userId: body.user.id,
      name: body.user.name,
      role: body.user.role,
      accessToken: body.accessToken,
      refreshToken: body.refreshToken,
      signedInAt: deps.now().toISOString(),
    };
    await writeSession(session);
    return session;
  }

  /** Offline sign-in: the PIN is checked against the verifier stored by the last online sign-in (FR-05). */
  async function offlineLogin(
    userId: string,
    pin: string,
    user: RosterUser,
  ): Promise<StoredSession> {
    const verifier = await deps.getSecret(pinKey(userId));
    if (!verifier) {
      throw new PinLoginError("سجّل الدخول مرة واحدة بالاتصال أولاً", "offline-unavailable");
    }
    if (!(await deps.verifyPin(pin, verifier))) {
      throw new PinLoginError("الرمز السري غير صحيح", "invalid");
    }
    const previous = await readSession();
    const session: StoredSession = {
      userId,
      name: user.name,
      role: user.role,
      accessToken: previous?.userId === userId ? previous.accessToken : "",
      refreshToken: previous?.userId === userId ? previous.refreshToken : "",
      signedInAt: deps.now().toISOString(),
    };
    await writeSession(session);
    return session;
  }

  /**
   * Renews the tokens. Only a 401 or 403 from /api/auth/refresh ends the session (FR-03); a network error or any other
   * status keeps it. Returns whether the user is still signed in.
   */
  async function refresh(): Promise<boolean> {
    const session = await readSession();
    if (!session?.refreshToken) return Boolean(session);
    let res: Response;
    try {
      res = await deps.fetch(`${deps.hubUrl()}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      });
    } catch {
      return true;
    }
    if (res.status === 401 || res.status === 403) {
      await endSession();
      return false;
    }
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as {
        accessToken?: string;
        refreshToken?: string;
      } | null;
      if (body?.accessToken && body.refreshToken) {
        await writeSession({
          ...session,
          accessToken: body.accessToken,
          refreshToken: body.refreshToken,
        });
      }
    }
    return true;
  }

  /**
   * Logout. With unsent operations it first asks for confirmation (E8): `{ needsConfirm: true, pending }`. After the user
   * confirms (`confirmed: true`) it tells the hub when online, then clears the tokens.
   */
  async function logout(
    options: { confirmed?: boolean } = {},
  ): Promise<{ needsConfirm: true; pending: number } | { needsConfirm: false }> {
    const pending = await deps.pendingCount();
    if (pending > 0 && !options.confirmed) return { needsConfirm: true, pending };
    const session = await readSession();
    if (session?.accessToken) {
      try {
        await deps.fetch(`${deps.hubUrl()}/api/auth/logout`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.accessToken}`,
          },
          body: JSON.stringify({ refreshToken: session.refreshToken }),
        });
      } catch {
        // offline: the tokens are cleared locally anyway
      }
    }
    await endSession();
    return { needsConfirm: false };
  }

  return { roster, pinLogin, offlineLogin, refresh, logout, current: readSession, endSession };
}

export type SessionService = ReturnType<typeof createSessionService>;

export function pendingLogoutMessage(pending: number): string {
  return `${pending} عمليات لم تُرسل بعد`;
}

/** The default dependencies on the device. */
export function deviceSessionDeps(
  parts: Pick<SessionDeps, "hubUrl" | "tenantId" | "deviceAuthHeader" | "pendingCount">,
): SessionDeps {
  return {
    ...parts,
    fetch: (...args) => globalThis.fetch(...args),
    getSecret,
    setSecret,
    deleteSecret,
    hashPin,
    verifyPin,
    now: () => new Date(),
  };
}
