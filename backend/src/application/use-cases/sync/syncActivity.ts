import type { CreateNotificationInput } from "../../../domain/entities/Notification.js";
import type { HubActivityEvent } from "./hubConfig.js";
import type { PulledUnit } from "./syncUseCases.js";

/**
 * In-app activity notifications for work done on OTHER devices.
 *
 * Pure message builders (no I/O) so the wording and deep links are unit-tested.
 * The caller persists the result through the ordinary notifications table,
 * which the header bell lists and the live toast layer pops.
 */

const ROLE_AR: Record<string, string> = {
  admin: "المدير",
  accountant: "المحاسب",
  warehouse: "أمين المستودع",
  viewer: "المستخدم",
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function actorOf(payload: Record<string, unknown>): string {
  return (
    str(payload.actorUserName) ??
    (str(payload.actorRole) ? ROLE_AR[String(payload.actorRole)] : null) ??
    "مستخدم آخر"
  );
}

function num(n: string | null): string {
  return n ? ` رقم #${n}` : "";
}

/** Notification for a unit pulled from the hub, or null when it is not worth a toast. */
export function describePulledUnit(unit: PulledUnit): CreateNotificationInput | null {
  const p = unit.payload ?? {};
  const actor = actorOf(p);
  const op = unit.operation;

  switch (unit.entityType) {
    case "invoice": {
      const kind = p.invoiceType === "entry" ? "إدخال" : p.invoiceType === "sale" ? "مبيعات" : "";
      const label = kind ? `فاتورة ${kind}` : "فاتورة";
      const n = num(str(p.invoiceNumber));
      const title =
        op === "create"
          ? `أضاف ${actor} ${label} جديدة${n}`
          : op === "update"
            ? `عدّل ${actor} ${label}${n}`
            : op === "cancel"
              ? `ألغى ${actor} ${label}${n}`
              : null;
      if (!title) return null;
      return {
        title,
        kind: "sync",
        severity: op === "cancel" ? "warning" : "info",
        targetPath: `/invoices/${unit.entityId}`,
      };
    }
    case "voucher": {
      const label = p.voucherKind === "payment" ? "سند دفع" : "سند قبض";
      const n = num(str(p.voucherNumber));
      if (op === "create") {
        return {
          title: `أضاف ${actor} ${label} جديداً${n}`,
          kind: "sync",
          severity: "info",
          targetPath: p.voucherKind === "payment" ? "/payments" : "/receipts",
        };
      }
      if (op === "cancel") {
        return {
          title: `ألغى ${actor} سنداً${n}`,
          kind: "sync",
          severity: "warning",
          targetPath: "/receipts",
        };
      }
      return null;
    }
    case "return": {
      const n = num(str(p.returnNumber));
      if (op === "create") {
        return {
          title: `أضاف ${actor} مرتجعاً جديداً${n}`,
          kind: "sync",
          severity: "info",
          targetPath: "/returns",
        };
      }
      if (op === "cancel") {
        return {
          title: `ألغى ${actor} مرتجعاً${n}`,
          kind: "sync",
          severity: "warning",
          targetPath: "/returns",
        };
      }
      return null;
    }
    case "expense": {
      const n = num(str(p.expenseNumber));
      if (op === "create") {
        return {
          title: `أضاف ${actor} مصروفاً جديداً${n}`,
          kind: "sync",
          severity: "info",
          targetPath: "/expenses",
        };
      }
      return null;
    }
    default:
      // Masters, ledger legs, settings… would flood the bell; they still sync.
      return null;
  }
}

/** Notification for a presence event reported through the hub. */
export function describeHubActivity(event: HubActivityEvent): CreateNotificationInput {
  const who =
    event.userName?.trim() || (event.userRole ? ROLE_AR[event.userRole] : null) || "مستخدم";
  const where = event.deviceLabel ? ` على جهاز ${event.deviceLabel}` : "";
  return {
    title: `${who} سجّل دخوله الآن`,
    detail: `تسجيل دخول${where}`,
    kind: "sync",
    severity: "info",
  };
}
