import { useQuery } from "@tanstack/react-query";
import { container } from "@/infrastructure/container";
import type { AuditLogDTO } from "@/infrastructure/api/AuditApiService";

/**
 * Invoice-tracking feature: the full audit timeline of one invoice
 * (create / each update with before-after snapshots / cancel), newest first.
 */
export function useInvoiceAudit(invoiceId: string | null | undefined) {
  return useQuery<AuditLogDTO[]>({
    queryKey: ["audit", "invoice", invoiceId],
    queryFn: () => container.audit.api.listByInvoice(invoiceId as string),
    enabled: !!invoiceId,
    staleTime: 5_000,
  });
}
