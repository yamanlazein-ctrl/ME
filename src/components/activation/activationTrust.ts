export type SetupStatusResponse = { isCompleted?: boolean; tenantId?: string };

/**
 * Pure decision, exported for unit testing without mounting the component:
 * given a successful `/api/setup/status` response and this device's locally
 * stored tenant id, should the LOCAL activation marker (`isActivated()`) be
 * trusted at all? `false` forces `clearLicense()` + the activation screen,
 * regardless of what the local marker says.
 */
export function shouldTrustLocalActivation(
  data: SetupStatusResponse,
  localTenantId: string | null,
): boolean {
  const tenantMismatch = Boolean(data.tenantId && localTenantId && data.tenantId !== localTenantId);
  return data.isCompleted !== false && !tenantMismatch;
}
