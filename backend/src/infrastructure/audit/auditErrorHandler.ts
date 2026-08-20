import { logger } from "../config/logger.js";

export interface AuditErrorContext {
  module: string;
  action: string;
  entityId: string;
  tenantId: string;
}

export function logAuditError(error: unknown, context: AuditErrorContext): void {
  logger.error(
    {
      module: context.module,
      action: context.action,
      entityId: context.entityId,
      tenantId: context.tenantId,
      error: error instanceof Error ? error.message : String(error),
    },
    "AUDIT_LOGGING_FAILED"
  );
}
