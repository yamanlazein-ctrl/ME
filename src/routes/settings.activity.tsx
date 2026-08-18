import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageCard } from "@/components/layout/PageCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Trash2 } from "lucide-react";
import { useSettings, clearActivity } from "@/presentation/hooks/useSettings";

export const Route = createFileRoute("/settings/activity")({ component: ActivityPage });

function ActivityPage() {
  const s = useSettings();
  const [q, setQ] = useState("");
  const filtered = s.activity.filter(
    (a) =>
      !q ||
      [a.user, a.module, a.action, a.detail].join(" ").toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <PageCard
      title="سجل النشاط"
      description="آخر الإجراءات التي تمت داخل النظام."
      noBodyPadding
      actions={
        <div className="flex items-center gap-2">
          <Input
            placeholder="بحث…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-8 w-48"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => confirm("مسح سجل النشاط بالكامل؟") && clearActivity()}
          >
            <Trash2 className="h-3.5 w-3.5 ml-1 text-destructive" /> مسح
          </Button>
        </div>
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
              <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{a.at}</td>
              <td className="px-3 py-2">{a.user}</td>
              <td className="px-3 py-2">{a.module}</td>
              <td className="px-3 py-2">{a.action}</td>
              <td className="px-3 py-2 text-muted-foreground">{a.detail ?? "—"}</td>
            </tr>
          ))}
          {filtered.length === 0 && (
            <tr>
              <td colSpan={5} className="p-10 text-center text-muted-foreground">
                لا توجد نشاطات مطابقة.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </PageCard>
  );
}
