import { AppShell } from "@/components/layout/AppShell";
import { PageCard } from "@/components/layout/PageCard";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  buildGlobalLedger,
  filterLedger,
  LEDGER_TYPE_LABEL,
  useLedgerEntries,
  type LedgerType,
  type LedgerStatus,
} from "@/presentation/hooks/useLedger";
import { customers, suppliers } from "@/presentation/hooks/useParties";
import { formatAmount } from "@/presentation/hooks/useCurrency";
import { formatDateTime } from "@/lib/utils";

export const Route = createFileRoute("/ledger")({
  component: LedgerPage,
});

function LedgerPage() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [type, setType] = useState<LedgerType | "all">("all");
  const [status, setStatus] = useState<LedgerStatus | "all">("all");
  const [partyId, setPartyId] = useState<string>("all");
  const [q, setQ] = useState("");
  const { data: entries } = useLedgerEntries({ limit: 1000 });
  const all = useMemo(() => buildGlobalLedger(entries ?? []), [entries]);
  const filtered = useMemo(() => {
    const f = filterLedger(all, {
      from: from || undefined,
      to: to || undefined,
      types: type === "all" ? undefined : [type],
      status,
    });
    return f.filter((e) => {
      if (partyId !== "all" && e.partyId !== partyId) return false;
      if (q) {
        const s = q.trim().toLowerCase();
        return (
          (e.referenceNumber ?? "").toLowerCase().includes(s) ||
          (e.description || "").toLowerCase().includes(s)
        );
      }
      return true;
    });
  }, [all, from, to, type, status, partyId, q]);

  const allParties = [...customers, ...suppliers];

  return (
    <AppShell
      title="دفتر الحركات المركزي"
      subtitle="كل الحركات المالية للنظام: الفواتير، السندات، المصاريف، المرتجعات، والتسويات."
    >
      <PageCard
        title="فلاتر البحث"
        description="تصفية الحركات حسب الفترة أو النوع أو الطرف."
      >
        <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
          <div>
            <Label className="text-[11px] text-muted-foreground">
              من تاريخ
            </Label>
            <Input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="h-10"
            />
          </div>
          <div>
            <Label className="text-[11px] text-muted-foreground">
              إلى تاريخ
            </Label>
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="h-10"
            />
          </div>
          <div>
            <Label className="text-[11px] text-muted-foreground">النوع</Label>
            <Select
              value={type}
              onValueChange={(v) => setType(v as LedgerType | "all")}
            >
              <SelectTrigger className="!h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">جميع الأنواع</SelectItem>
                {Object.entries(LEDGER_TYPE_LABEL).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-[11px] text-muted-foreground">الطرف</Label>
            <Select value={partyId} onValueChange={setPartyId}>
              <SelectTrigger className="!h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">الكل</SelectItem>
                {allParties.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-[11px] text-muted-foreground">الحالة</Label>
            <Select
              value={status}
              onValueChange={(v) => setStatus(v as LedgerStatus | "all")}
            >
              <SelectTrigger className="!h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">الكل</SelectItem>
                <SelectItem value="active">نشطة</SelectItem>
                <SelectItem value="cancelled">ملغاة</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-[11px] text-muted-foreground">بحث</Label>
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="رقم / وصف"
              className="h-10"
            />
          </div>
        </div>
      </PageCard>

      <PageCard
        title="الحركات"
        description={`عرض ${filtered.length} حركة.`}
        noBodyPadding
      >
        <div className="w-full overflow-x-auto">
          <table className="w-full min-w-[900px] text-right text-sm">
            <thead className="bg-secondary/60 text-[11px] font-semibold uppercase text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-2.5">
                <th>التاريخ</th>
                <th>النوع</th>
                <th>الوصف</th>
                <th>المرجع</th>
                <th>الطرف</th>
                <th className="text-left">مدين</th>
                <th className="text-left">دائن</th>
                <th>الصندوق</th>
                <th>الحالة</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((r) => {
                const party = allParties.find((p) => p.id === r.partyId);
                const muted = r.status === "cancelled";
                return (
                  <tr
                    key={r.id}
                    className={
                      muted
                        ? "bg-destructive/5 text-muted-foreground line-through"
                        : ""
                    }
                  >
                    <td className="px-3 py-2 tabular-nums">
                      {formatDateTime(r.createdAt)}
                    </td>
                    <td className="px-3 py-2">{LEDGER_TYPE_LABEL[r.type]}</td>
                    <td className="px-3 py-2">{r.description}</td>
                    <td className="px-3 py-2 tabular-nums text-primary">
                      {r.invoiceId ? (
                        <Link to="/invoices/$id" params={{ id: r.invoiceId }}>
                          {r.referenceNumber}
                        </Link>
                      ) : (
                        r.referenceNumber
                      )}
                    </td>
                    <td className="px-3 py-2">{party?.name ?? "—"}</td>
                    <td className="px-3 py-2 text-left tabular-nums">
                      {r.debit ? formatAmount(r.debit, r.currency) : "—"}
                    </td>
                    <td className="px-3 py-2 text-left tabular-nums">
                      {r.credit ? formatAmount(r.credit, r.currency) : "—"}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {r.cashImpact === "in"
                        ? "وارد"
                        : r.cashImpact === "out"
                          ? "صادر"
                          : "لا يوجد"}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {r.status === "active" ? "نشطة" : "ملغاة"}
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td
                    colSpan={9}
                    className="p-10 text-center text-muted-foreground"
                  >
                    لا حركات مطابقة.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </PageCard>

      <div className="flex justify-end gap-2">
        <Button variant="outline">طباعة</Button>
        <Button variant="outline">تصدير Excel</Button>
      </div>
    </AppShell>
  );
}
