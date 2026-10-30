// Local notifications only (FR-37, no server push in v1). After each sync run: one notification per newly rejected document
// (naming its number), one when sync stops (version mismatch, revoked, unknown device) and one for fabrics that fell below
// `minStockKg` after a pull. Permission is asked on first use.
import * as Notifications from "expo-notifications";

export interface Notice {
  kind: "rejected" | "stopped" | "lowStock";
  title: string;
  body: string;
}

export interface NotifyInput {
  /** Document numbers whose units were rejected and have not been announced yet. */
  newRejected: string[];
  /** Set when the loop halted during this run. */
  stopped?: "versionMismatch" | "revoked" | "unknownDevice";
  /** Fabrics currently below their minimum, and those already announced. */
  lowStockNow: string[];
  alreadyAnnouncedLowStock: ReadonlySet<string>;
  /** Only announce stock after a pull that changed local data. */
  pulledChanges: boolean;
}

const STOP_TEXT: Record<NonNullable<NotifyInput["stopped"]>, string> = {
  versionMismatch: "تحديث مطلوب: توقفت المزامنة حتى تحديث التطبيق",
  revoked: "تم تعطيل هذا الجهاز من المركز",
  unknownDevice: "الجهاز غير مسجّل في المركز: سجّله لمتابعة المزامنة",
};

export function planNotifications(input: NotifyInput): Notice[] {
  const notices: Notice[] = input.newRejected.map((number) => ({
    kind: "rejected",
    title: "رُفض مستند عند المزامنة",
    body: `المستند ${number} لم يُقبل في المركز وأُلغي على هذا الهاتف`,
  }));
  if (input.stopped) {
    notices.push({ kind: "stopped", title: "توقفت المزامنة", body: STOP_TEXT[input.stopped] });
  }
  if (input.pulledChanges) {
    const fresh = input.lowStockNow.filter((name) => !input.alreadyAnnouncedLowStock.has(name));
    if (fresh.length) {
      notices.push({
        kind: "lowStock",
        title: "مخزون منخفض",
        body: `أقمشة تحت الحد الأدنى: ${fresh.slice(0, 5).join("، ")}${fresh.length > 5 ? "…" : ""}`,
      });
    }
  }
  return notices;
}

let permissionAsked = false;

export async function ensureNotificationPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (permissionAsked) return false;
  permissionAsked = true;
  const asked = await Notifications.requestPermissionsAsync();
  return asked.granted;
}

export async function sendNotices(notices: Notice[]): Promise<void> {
  if (notices.length === 0) return;
  if (!(await ensureNotificationPermission())) return;
  for (const notice of notices) {
    await Notifications.scheduleNotificationAsync({
      content: { title: notice.title, body: notice.body },
      trigger: null,
    });
  }
}
