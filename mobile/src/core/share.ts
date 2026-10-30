// Sharing a document PDF (FR-29, FR-30, E14). The system share sheet hands the file to WhatsApp or any other app with a
// read grant on the file; the user picks the app and the contact. Nothing is ever sent automatically, and the app cannot
// know whether the receiver got it, so it only ever says the sheet opened.

export interface ShareDeps {
  isAvailable(): Promise<boolean>;
  /** Opens the share sheet; resolves when it closes (whether or not something was sent). */
  open(uri: string, title: string): Promise<void>;
}

export type ShareOutcome = { ok: true; message: string } | { ok: false; message: string };

export const SHARE_OPENED = "فُتحت نافذة المشاركة: اختر واتساب (أو أي تطبيق) ثم جهة الاتصال.";
export const SHARE_UNAVAILABLE = "لا يوجد على هذا الهاتف تطبيق يستقبل الملفات للمشاركة.";

export async function sharePdf(uri: string, title: string, deps: ShareDeps): Promise<ShareOutcome> {
  if (!(await deps.isAvailable())) return { ok: false, message: SHARE_UNAVAILABLE };
  try {
    await deps.open(uri, title);
    return { ok: true, message: SHARE_OPENED };
  } catch {
    return { ok: false, message: "تعذّر فتح نافذة المشاركة. حاول مجدداً." };
  }
}
