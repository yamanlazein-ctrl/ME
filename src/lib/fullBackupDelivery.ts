/**
 * Full-backup delivery (specs/001-desktop-sqlite-engine T100, U-2 / I-11).
 *
 *   - Web / cloud: the server streams the zip and the browser saves it through an anchor download —
 *     unchanged.
 *   - Desktop (Tauri): the API bridge carries text only, so the zip bytes never cross it. The server
 *     creates a VERIFIED backup and answers with its identity (`?deliver=metadata`); the shell copies
 *     the file to where the user chooses and success is reported only when the saved copy's size and
 *     sha256 equal the verified file's.
 */
import { isTauri, saveBackupFile } from "@/infrastructure/tauri-bridge";
import { localToday } from "@/lib/localDate";

export interface DeliveredBackup {
  /** The file name (web) or the full saved path (desktop). */
  name: string;
  sizeBytes: number;
  /** Desktop only: the verified sha256 the saved copy matched. */
  sha256?: string;
  verified: boolean;
}

interface BackupMetadata {
  status: "VERIFIED";
  fileName: string;
  path: string;
  sizeBytes: number;
  sha256: string;
}

async function failure(res: Response): Promise<Error> {
  const err = await res.json().catch(() => ({ message: "فشل الاتصال بالسيرفر" }));
  return new Error(err.message || "فشل إنشاء النسخة");
}

/** The web path, exactly as the settings page always did it. */
async function deliverInBrowser(
  token: string | null,
  signal?: AbortSignal,
): Promise<DeliveredBackup> {
  const res = await fetch("/api/backup/full", {
    method: "POST",
    headers: {
      Authorization: token ? `Bearer ${token}` : "",
    },
    signal,
  });
  if (!res.ok) throw await failure(res);

  const blob = await res.blob();
  const size = blob.size;
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const fileName =
    /filename="([^"]+)"/.exec(disposition)?.[1] ?? `MotardERP-Backup-${localToday()}.zip`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return { name: fileName, sizeBytes: size, verified: false };
}

/** The desktop path: a VERIFIED file, copied by the shell and re-checked. Null = the user cancelled. */
async function deliverOnDesktop(token: string | null): Promise<DeliveredBackup | null> {
  const res = await fetch("/api/backup/full?deliver=metadata", {
    method: "POST",
    headers: {
      Authorization: token ? `Bearer ${token}` : "",
    },
  });
  if (!res.ok) throw await failure(res);
  const meta = (await res.json()) as BackupMetadata;
  if (meta.status !== "VERIFIED" || !meta.path || !meta.sha256) {
    throw new Error("لم يُنشئ الخادم نسخة موثَّقة — لم يُحفظ أي ملف.");
  }
  const saved = await saveBackupFile({
    sourcePath: meta.path,
    expectedSha256: meta.sha256,
    expectedSize: meta.sizeBytes,
    suggestedName: meta.fileName,
  });
  if (!saved) return null;
  if (
    saved.sizeBytes !== meta.sizeBytes ||
    saved.sha256.toLowerCase() !== meta.sha256.toLowerCase()
  ) {
    throw new Error("الملف المحفوظ لا يطابق النسخة الموثَّقة — أعد المحاولة في مكان آخر.");
  }
  return { name: saved.path, sizeBytes: saved.sizeBytes, sha256: saved.sha256, verified: true };
}

export async function deliverFullBackup(
  token: string | null,
  signal?: AbortSignal,
): Promise<DeliveredBackup | null> {
  return isTauri() ? deliverOnDesktop(token) : deliverInBrowser(token, signal);
}
