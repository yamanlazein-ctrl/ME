// Phone print layouts (FR-29, research R8, spike S3).
//
// Deviation from R8, recorded in evidence/T036.md: the desktop print components
// (src/components/print/InvoicePrintDocument.tsx, PartyStatementDocument.tsx) cannot be bundled by Metro:
// they pull in the web data layer (useSettings/useLedger → React Query + the API client), a CSS import and
// a Vite-only `?inline` image. The desktop already ships the same documents as pure HTML builders in
// packages/shared/src/archiveDocuments.ts (used by the Drive archive "so an archived document matches what the
// user prints"). The phone uses those builders unchanged, so the amounts come from the same code.
import {
  buildInvoiceBody,
  buildStatementBody,
  wrapArchiveDocument,
  type ArchiveInvoiceHeader,
  type ArchiveInvoiceLine,
  type ArchiveLeg,
  type ArchivePaper,
} from "@erp/shared";

export interface InvoicePrintData {
  header: ArchiveInvoiceHeader;
  lines: ArchiveInvoiceLine[];
  paper?: ArchivePaper;
}

export interface StatementPrintData {
  partyName: string;
  partyKind: "customer" | "supplier";
  currency: string;
  periodFrom: string;
  periodTo: string;
  opening: number;
  legs: ArchiveLeg[];
  paper?: ArchivePaper;
}

export function renderInvoiceHtml(data: InvoicePrintData): string {
  return wrapArchiveDocument({
    title: data.header.number,
    bodyHtml: buildInvoiceBody(data.header, data.lines),
    paper: data.paper ?? "A4",
  });
}

export function renderStatementHtml(data: StatementPrintData): string {
  return wrapArchiveDocument({
    title: `${data.partyName} — ${data.currency}`,
    bodyHtml: buildStatementBody(data),
    paper: data.paper ?? "A4",
  });
}
