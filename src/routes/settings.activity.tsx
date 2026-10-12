import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { PageCard } from "@/components/layout/PageCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { container } from "@/infrastructure/container";

export const Route = createFileRoute("/settings/activity")({ component: ActivityPage });

const PAGE = 100; // the audit route's cap

/**
 * hermes F-016: this screen used to list a device-local array that was empty after every reload and
 * could be wiped with one click. It now reads the tenant's durable audit trail (`GET /api/audit-logs`,
 * written server-side by the business use cases), newest first, one page at a time. There is no
 * "clear": an audit trail is not the client's to delete.
 */
function ActivityPage() {
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const page = useQuery({
    queryKey: ["audit-logs", "all", offset],
    queryFn: () => container.audit.api.listPage(offset, PAGE),
    placeholderData: keepPreviousData,
  });
  const rows = page.data?.data ?? [];
  const total = page.data?.total ?? 0;
  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? rows.filter((a) =>
        [a.actorName, a.module, a.action, a.detail].join(" ").toLowerCase().includes(needle),
      )
    : rows;
  return (
    <PageCard
      title="سجل النشاط"
      description="سجل التدقيق المحفوظ على الخادم: من نفّذ ماذا ومتى. البحث يشمل الصفحة المعروضة."
      noBodyPadding
      actions={
        <Input
          placeholder="بحث في هذه الصفحة…"
          aria-label="بحث في سجل النشاط"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="h-8 w-48"
        />
      }
    >
      <table className="w-full text-right text-sm">
        <thead className="bg-secondary/60 text-[11px] uppercase text-muted-foreground">
          <tr className="[&>th]:px-3 [&>th]:py-2.5">
            <th>الوقت</th>
            <th>المستخدم</th>
            <th>القسم</th>
            <th>الإجراء</th>
            <th>التفاصيل</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {filtered.map((a) => (
            <tr key={a.id}>
              <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                {a.createdAt.replace("T", " ").slice(0, 19)}
              </td>
              <td className="px-3 py-2">{a.actorName ?? "—"}</td>
              <td className="px-3 py-2">{a.module}</td>
              <td className="px-3 py-2">{a.action}</td>
              <td className="px-3 py-2 text-muted-foreground">{a.detail ?? "—"}</td>
            </tr>
          ))}
          {page.isError && (
            <tr>
              <td colSpan={5} className="p-10 text-center text-destructive" role="alert">
                تعذّر تحميل سجل النشاط.{" "}
                <Button size="sm" variant="outline" onClick={() => void page.refetch()}>
                  إعادة المحاولة
                </Button>
              </td>
            </tr>
          )}
          {!page.isError && !page.isLoading && filtered.length === 0 && (
            <tr>
              <td colSpan={5} className="p-10 text-center text-muted-foreground">
                لا توجد نشاطات مطابقة.
              </td>
            </tr>
          )}
          {page.isLoading && (
            <tr>
              <td colSpan={5} className="p-10 text-center text-muted-foreground">
                جارٍ التحميل…
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {total > PAGE && (
        <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
          <span>
            {offset + 1}–{Math.min(offset + PAGE, total)} من {total}
          </span>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={offset === 0 || page.isFetching}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
            >
              الأحدث
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={offset + PAGE >= total || page.isFetching}
              onClick={() => setOffset(offset + PAGE)}
            >
              الأقدم
            </Button>
          </div>
        </div>
      )}
    </PageCard>
  );
}
