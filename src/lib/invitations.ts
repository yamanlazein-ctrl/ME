/**
 * Invitation API client (Phase ج).
 *
 * Talks to the customer ERP backend `/api/invitations/*` endpoints:
 *   - generate / list / revoke  → admin (Bearer token required)
 *   - validate / consume        → public (no auth; consume creates the user
 *     account and/or registers the accepting device)
 *
 * Self-contained on purpose: it resolves the base URL and reads the auth
 * token the same way the rest of the app does, without pulling in the DI
 * container, so it can be used from the login screen (pre-auth).
 */

export type InvitationType = "device" | "user";

export interface Invitation {
  id: string;
  tenantId: string;
  code: string;
  type: InvitationType;
  expiresAt: string;
  revokedAt: string | null;
  useCount: number;
  metadata: Record<string, unknown> | null;
  createdBy: string;
  createdAt: string;
}

export interface GenerateInvitationInput {
  type: InvitationType;
  ttlMinutes?: number;
  targetName?: string;
  targetEmail?: string;
  targetRole?: string;
}

export interface ConsumeInvitationInput {
  code: string;
  password?: string;
  deviceFingerprint?: string;
}

export interface ConsumeInvitationResult {
  consumed: boolean;
  type: InvitationType;
  tenantId: string;
  createdUserId?: string;
  registeredDeviceId?: string;
}

function apiBase(): string {
  const raw = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim();
  // When a full backend origin is configured use it as-is; otherwise fall back
  // to same-origin (paths below already carry the /api prefix).
  if (!raw || raw === "/api") return "";
  return raw.replace(/\/+$/, "");
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  try {
    const token = localStorage.getItem("erp.auth.accessToken");
    if (token) headers["Authorization"] = `Bearer ${token}`;
  } catch {
    /* no token — public endpoints still work */
  }
  return headers;
}

async function post<T>(path: string, body: unknown, withAuth: boolean): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: "POST",
    headers: withAuth ? authHeaders() : { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      (data as { message?: string }).message || `فشل الطلب (${res.status})`,
    );
  }
  return data as T;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, { method: "GET", headers: authHeaders() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { message?: string }).message || `فشل الطلب (${res.status})`);
  }
  return data as T;
}

/** Admin: create an invitation code (user or device). */
export function generateInvitation(input: GenerateInvitationInput): Promise<Invitation> {
  return post<Invitation>("/api/invitations/generate", input, true);
}

/** Admin: list the tenant's invitation codes. */
export async function listInvitations(): Promise<Invitation[]> {
  const data = await get<{ invitations?: Invitation[] } | Invitation[]>(
    "/api/invitations/list",
  );
  return Array.isArray(data) ? data : (data.invitations ?? []);
}

/** Admin: revoke an invitation code by id. */
export function revokeInvitation(id: string): Promise<{ ok: boolean }> {
  return post<{ ok: boolean }>(`/api/invitations/revoke/${id}`, {}, true);
}

/** Public: check whether a code is still valid (not used/expired/revoked). */
export function validateInvitation(
  code: string,
): Promise<{ valid: boolean; type: InvitationType; tenantId: string }> {
  return post<{ valid: boolean; type: InvitationType; tenantId: string }>(
    "/api/invitations/validate",
    { code },
    false,
  );
}

/**
 * Public: consume a code. For a `user` invitation this creates the account
 * (password required) and — when a device fingerprint is supplied — registers
 * the accepting device against the license device cap.
 */
export function consumeInvitation(
  input: ConsumeInvitationInput,
): Promise<ConsumeInvitationResult> {
  return post<ConsumeInvitationResult>("/api/invitations/consume", input, false);
}
