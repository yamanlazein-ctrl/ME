import { AppShell } from "@/components/layout/AppShell";
import { PageCard } from "@/components/layout/PageCard";
import { Button } from "@/components/ui/button";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { NameCombobox } from "@/components/ui/name-combobox";
import { formatAmount } from "@/presentation/hooks/useCurrency";
import { formatDateTime } from "@/lib/utils";
import {
  useCancelExpense,
  useExpenseNamesList,
  useExpensesList,
} from "@/presentation/hooks/useExpenses";

export const Route = createFileRoute("/expenses/")({ component: ExpensesList });

function ExpensesList() {
  const [cat, setCat] = useState<string>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const { data: names = [] } = useExpenseNamesList();
  const { data: list = [] } = useExpensesList({ category: cat, from, to });
  const cancel = useCancelExpense();
  return (
    <AppShell
      title="المصاريف"
      subtitle="تكاليف تشغيلية للشركة — تخصم من الصندوق مباشرة إن دفعت نقداً."
      actions={
        <Link to="/expenses/new">
          <Button className="bg-primary text-primary-foreground">
            <Plus className="h-4 w-4 ml-1" /> مصروف جديد
          </Button>
        </Link>
      }
    >
      <PageCard title="الفلاتر">
        <div className="grid gap-3 md:grid-cols-3">
          <div>
            <label className="text-[11px] text-muted-foreground">اسم المصروف</label>
            <NameCombobox
              value={cat}
              onChange={setCat}
              options={names}
              allowCreate={false}
              placeholder="جميع الأسماء"
            />
          </div>
          <div>
            <label className="text-[11px] text-muted-foreground">من تاريخ</label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="text-[11px] text-muted-foreground">إلى تاريخ</label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
      </PageCard>

      <PageCard title="القائمة" description={`${list.length} مصروف.`} noBodyPadding>
        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[800px] text-right text-sm">
            <thead className="bg-secondary/60 text-[11px] uppercase text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-2.5">
                <th>الرقم</th>
                <th>التاريخ</th>
                <th>الاسم</th>
                <th>الوصف</th>
                <th className="text-left">المبلغ</th>
                <th>من الصندوق</th>
                <th>الحالة</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {list.map((e) => (
                <tr
                  key={e.id}
                  className={e.status === "cancelled" ? "text-muted-foreground line-through" : ""}
                >
                  <td className="px-3 py-2 tabular-nums font-semibold">{e.number}</td>
                  <td className="px-3 py-2 tabular-nums">{formatDateTime(e.createdAt)}</td>
                  <td className="px-3 py-2">{e.category}</td>
                  <td className="px-3 py-2">{e.description}</td>
                  <td className="px-3 py-2 text-left tabular-nums font-bold">
                    {formatAmount(e.amount, e.currency)}
                  </td>
                  <td className="px-3 py-2">{e.paidFromCashbox ? "نعم" : "لا"}</td>
                  <td className="px-3 py-2 text-xs">{e.status === "active" ? "مسجل" : "ملغى"}</td>
                  <td className="px-3 py-2">
                    {e.status === "active" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          if (confirm(`إلغاء المصروف ${e.number}؟`)) cancel.mutate(e.id);
                        }}
                      >
                        إلغاء
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {list.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-10 text-center text-muted-foreground">
                    لا مصاريف.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </PageCard>
    </AppShell>
  );
}
