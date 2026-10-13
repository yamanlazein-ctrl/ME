import { getInstallTenantId } from "@/lib/license-state";

export function resolveTenantId(): string {
  return (
    getInstallTenantId() ?? (import.meta.env.VITE_DEFAULT_TENANT_ID as string | undefined) ?? ""
  );
}
