import { settings } from "@/presentation/hooks/useSettings";
import type { ArchiveDocType } from "@/infrastructure/tauri-bridge";
import type { PrintArchiveMeta } from "@/components/print/printPortal";

/** Build Desktop-archive filename stem (Issue 12/13): company_date_TYPE-number. */
export function documentArchiveStem(opts: {
  date: string;
  typeLabel: string;
  number: string;
}): string {
  const company = (settings.company?.name || "Motard Fabrics Group").replace(/[<>:"/\\|?*]/g, "_");
  const num = (opts.number || "draft").replace(/[<>:"/\\|?*]/g, "_");
  return `${company}_${opts.date}_${opts.typeLabel}-${num}`;
}

export function archiveMeta(
  docType: ArchiveDocType,
  opts: { date: string; typeLabel: string; number: string },
): PrintArchiveMeta {
  return { docType, fileStem: documentArchiveStem(opts) };
}
