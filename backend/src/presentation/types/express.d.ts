import type { TenantContext } from "../../domain/types/index.js";

declare global {
  namespace Express {
    interface Request {
      id: string;
      tenantContext?: TenantContext;
      validatedBody?: unknown;
      validatedQuery?: unknown;
      systemAdmin?: {
        id: string;
        email: string;
        role: string;
      };
    }
  }
}
