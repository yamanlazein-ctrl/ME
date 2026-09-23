import { documentPdfStem } from "@erp/shared";
import type { ArchiveDocType } from "@/infrastructure/tauri-bridge";
import type { PrintArchiveMeta } from "@/components/print/printPortal";

/**
 * Desktop / print PDF stem:
 *   [نوع المستند]_[اسم العميل أو المورد]_[رقم الفاتورة]_[التاريخ]
 */
export function documentArchiveStem(opts: {
  docType: string;
  partyName?: string | null;
  number?: string | null;
  date?: string | null;
  /** @deprecated prefer docType + partyName */
  typeLabel?: string;
}): string {
  return documentPdfStem({
    docType: opts.docType || opts.typeLabel || "مستند",
    partyName: opts.partyName,
    number: opts.number,
    date: opts.date,
  });
}

export function archiveMeta(
  docType: ArchiveDocType,
  opts: {
    date: string;
    number: string;
    partyName?: string | null;
    typeLabel?: string;
  },
): PrintArchiveMeta {
  return {
    docType,
    fileStem: documentArchiveStem({
      docType,
      partyName: opts.partyName,
      number: opts.number,
      date: opts.date,
      typeLabel: opts.typeLabel,
    }),
  };
}
