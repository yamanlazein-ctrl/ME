import type { License, Activation, AuditEvent, CreateLicenseInput, Edition, Plan } from "@/types";

/**
 * Same-origin by default (empty base ⇒ relative paths).
 *
 * The Vite dev server proxies `/license-admin` and `/v1` to the License
 * Server on :8081 (see `vite.config.ts`), so the browser issues a
 * same-origin request and CORS never enters the picture. This replaces the
 * previous absolute `http://localhost:8081`, which was blocked by CORS
 * because the License Server's allowlist did not contain the dashboard's
 * own origin (:5174).
 *
 * ⚠️ PRODUCTION: a built static bundle has no Vite dev server, so nothing
 * proxies these paths. When deploying, either
 *   (a) serve this bundle behind a real reverse proxy (nginx/Caddy) that
 *       forwards `/license-admin` and `/v1` to the License Server, or
 *   (b) set `VITE_LICENSE_SERVER_URL` to the License Server's absolute
 *       origin — in which case that origin MUST be listed in the server's
 *       `CORS_ORIGIN` allowlist, or CORS will block it again.
 */
const API_BASE = (import.meta.env.VITE_LICENSE_SERVER_URL ?? "").replace(/\/+$/, "");

function getAuthHeaders(): Record<string, string> {
  const token = sessionStorage.getItem("admin_token");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...getAuthHeaders(), ...options?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `خطأ ${res.status}`);
  }
  return res.json();
}

export async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${API_BASE}/license-admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || "فشل تسجيل الدخول");
  }
  const data = (await res.json()) as { token: string };
  return data.token;
}

export async function fetchLicenses(): Promise<License[]> {
  const data = await apiFetch<{ licenses: License[] }>("/license-admin/licenses");
  return data.licenses;
}

export async function createLicense(input: CreateLicenseInput): Promise<License> {
  const body: Record<string, unknown> = {
    edition: input.edition,
    plan: input.plan,
    licenseModel: input.licenseModel,
    featureAdd: input.featureAdd ?? [],
    featureRemove: input.featureRemove ?? [],
    companyName: input.companyName,
  };
  if (input.customerName) body.customerName = input.customerName;
  if (input.customerPhone) body.customerPhone = input.customerPhone;
  if (input.customerNotes) body.customerNotes = input.customerNotes;
  if (input.limits) body.limits = input.limits;
  if (input.bindingType) body.bindingType = input.bindingType;
  if (input.bindingValue) body.bindingValue = input.bindingValue;
  if (input.transferPolicy) body.transferPolicy = input.transferPolicy;
  if (input.updatePolicy) body.updatePolicy = input.updatePolicy;
  if (input.backupPolicy) body.backupPolicy = input.backupPolicy;
  if (input.expiresInDays) {
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + input.expiresInDays);
    body.expiresAt = expiry.toISOString();
  }
  const data = await apiFetch<{ license: License }>("/license-admin/licenses", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.license;
}

export async function fetchActivations(): Promise<Activation[]> {
  const data = await apiFetch<{ activations: Activation[] }>("/license-admin/activations");
  return data.activations;
}

export async function deactivateActivation(activationId: string, reason?: string): Promise<void> {
  await apiFetch(`/license-admin/activations/${activationId}/deactivate`, {
    method: "POST",
    body: JSON.stringify({ reason: reason || "admin_deactivation" }),
  });
}

export async function fetchAuditLogs(licenseId: string): Promise<AuditEvent[]> {
  const res = await fetch(`${API_BASE}/license/${licenseId}/audit`, {
    headers: getAuthHeaders(),
  }).catch(() => null);
  if (!res?.ok) return [];
  const data = await res.json();
  return data.events ?? [];
}

export type { Edition, Plan };
