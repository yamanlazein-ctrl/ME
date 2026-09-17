import { createFileRoute, Link } from "@tanstack/react-router";
import { AppShell } from "@/components/layout/AppShell";
import { PageCard } from "@/components/layout/PageCard";
import { Button } from "@/components/ui/button";
import {
  useOpenSyncConflicts,
  useResolveSyncConflict,
} from "@/presentation/hooks/useSyncConflicts";
import type { SyncConflictRow } from "@/infrastructure/api/SyncConflictsApiService";

export const Route = createFileRoute("/sync/conflicts")({ component: SyncConflictsPage });

const ENTITY_AR: Record<string, string> = {
  invoice: "فاتورة",
  voucher: "سند",
  return: "مرتجع",
  order: "طلبية",
  expense: "مصروف",
  party: "حساب",
  fabric: "قماش",
  color: "لون",
  roll: "لفة",
  settings: "إعدادات",
  user: "مستخدم",
};

const OP_AR: Record<string, string> = {
  update: "تعديل",
  cancel: "إلغاء",
};

function entityLabel(type: string): string {
  return ENTITY_AR[type] ?? type;
}

function intentDiffEntries(intent: Record<string, unknown> | null): [string, string][] {
  if (!intent) return [];
  const skip = new Set(["tenantId", "opId", "dependencies", "id"]);
  return Object.entries(intent)
    .filter(([k, v]) => !skip.has(k) && v !== undefined && typeof v !== "object")
    .slice(0, 24)
    .map(([k, v]) => [k, String(v)]);
}

function SyncConflictsPage() {
  const { data, isLoading, error, refetch } = useOpenSyncConflicts();
  const resolve = useResolveSyncConflict();
  const items = data ?? [];

  return (
    <AppShell
      title="تعارضات المزامنة"
      subtitle="تعديلات خسرت أمام نسخة المركز — القرار يدوي، بلا دمج صامت."
    >
      <PageCard
        title="تعارضات مفتوحة"
        description="كل صف هو عملية محلية لم تُطبَّق لأن نسخة المستند على المركز تغيّرت. اختر: الإبقاء على المركز، إعادة الإرسال كتعديل جديد على النسخة الحالية، أو سحب التعديل المحلي."
        actions={
          <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
            تحديث
          </Button>
        }
      >
        {isLoading && <p className="p-4 text-sm text-muted-foreground">جاري التحميل…</p>}
        {error && (
          <p className="p-4 text-sm text-destructive">تعذّر جلب التعارضات. تحقق من الجلسة والصلاحية.</p>
        )}
        {!isLoading && items.length === 0 && (
          <p className="p-6 text-center text-sm text-muted-foreground">لا توجد تعارضات مفتوحة.</p>
        )}
        <ul className="divide-y divide-border">
          {items.map((row) => (
            <ConflictCard
              key={row.id}
              row={row}
              busy={resolve.isPending}
              onDecide={(decision) => {
                void resolve.mutateAsync({ conflictId: row.id, decision });
              }}
            />
          ))}
        </ul>
      </PageCard>
    </AppShell>
  );
}

function ConflictCard({
  row,
  busy,
  onDecide,
}: {
  row: SyncConflictRow;
  busy: boolean;
  onDecide: (d: "keep-server" | "rebase" | "withdraw") => void;
}) {
  const diffs = intentDiffEntries(row.localIntent);
  return (
    <li className="space-y-3 px-5 py-4 text-right">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-foreground">
            {entityLabel(row.entityType)} — {OP_AR[row.operation] ?? row.operation}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            نسخة الجهاز (الأساس): {row.baseVersion ?? "—"} · نسخة المركز الفائزة:{" "}
            {row.serverVersion ?? "—"} · {new Date(row.createdAt).toLocaleString("ar")}
          </div>
        </div>
        {row.entityType === "invoice" && (
          <Link
            to="/invoices/$id"
            params={{ id: row.entityId }}
            className="text-xs font-medium text-primary underline-offset-2 hover:underline"
          >
            فتح المستند
          </Link>
        )}
        {row.entityType === "order" && (
          <Link
            to="/orders/$id"
            params={{ id: row.entityId }}
            className="text-xs font-medium text-primary underline-offset-2 hover:underline"
          >
            فتح الطلبية
          </Link>
        )}
        {row.entityType === "return" && (
          <Link to="/returns" className="text-xs font-medium text-primary underline-offset-2 hover:underline">
            سجل المرتجعات
          </Link>
        )}
      </div>
      <p className="text-xs leading-6 text-muted-foreground">
        جهازك عدّل من النسخة {row.baseVersion ?? "؟"} بينما المركز قبل تعديلاً آخر وصار على النسخة{" "}
        {row.serverVersion ?? "؟"}. لا يُطبَّق تعديلك تلقائياً حتى تختار قراراً.
      </p>
      {diffs.length > 0 && (
        <div className="rounded-lg border border-border bg-secondary/40 p-3">
          <div className="mb-2 text-[11px] font-semibold text-foreground">حقول النية المحلية (ما حاول الجهاز حفظه)</div>
          <dl className="grid gap-1 text-[11px]">
            {diffs.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="font-mono text-foreground">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => onDecide("keep-server")}
        >
          إبقاء نسخة المركز
        </Button>
        <Button type="button" size="sm" disabled={busy} onClick={() => onDecide("rebase")}>
          إعادة الإرسال على نسخة المركز
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => onDecide("withdraw")}
        >
          سحب التعديل المحلي
        </Button>
      </div>
      <p className="text-[11px] leading-5 text-muted-foreground">
        إبقاء المركز يغلق التعارض دون تطبيق نيتك. السحب يلغي النية المحلية. إعادة الإرسال تسجّل القرار ثم يجب فتح المستند وحفظ التعديل من جديد على النسخة الحالية — ليس استبدالاً صامتاً.
      </p>
    </li>
  );
}
