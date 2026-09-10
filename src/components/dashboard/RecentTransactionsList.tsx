import { Link } from "@tanstack/react-router";
import {
  ArrowLeftRight,
  ChevronLeft,
  PackagePlus,
  RotateCcw,
  ShoppingCart,
  Wallet,
} from "lucide-react";
import { useDashboard } from "@/presentation/hooks/useDashboard";
import { type TransactionDTO } from "@/application/ports/IDashboardRepository";
import { formatAmount, type Currency } from "@/presentation/hooks/useCurrency";

const META: Record<
  TransactionDTO["type"],
  { label: string; icon: typeof ShoppingCart; tone: string }
> = {
  sale: {
    label: "فاتورة مبيع",
    icon: ShoppingCart,
    tone: "bg-primary/15 text-primary border-primary/25",
  },
  payment: {
    label: "دفعة مقبوضة",
    icon: Wallet,
    tone: "bg-success/15 text-success border-success/30",
  },
  entry: {
    label: "فاتورة دخول",
    icon: PackagePlus,
    tone: "bg-chart-3/20 text-chart-3 border-chart-3/30",
  },
  return: {
    label: "مرتجع",
    icon: RotateCcw,
    tone: "bg-destructive/15 text-destructive border-destructive/30",
  },
};

function partyOf(t: TransactionDTO): string {
  if (t.type === "payment") return t.party ?? "";
  if (t.type === "entry") return t.supplier ?? t.party ?? "";
  return t.customer ?? t.party ?? "";
}

function refOf(t: TransactionDTO): string {
  return t.type === "payment" || t.type === "return" ? (t.reference ?? "") : (t.invoiceNo ?? "");
}

function detailOf(t: TransactionDTO): string {
  if (t.type === "payment") return `تسديد على ${t.reference ?? ""}`;
  return t.detail;
}

export function RecentTransactionsList() {
  const { data } = useDashboard();
  const items = data?.recentTransactions ?? [];

  return (
    <div
      data-od-id="panel-recent-transactions"
      className="flex flex-col rounded-xl border border-border bg-card shadow-soft"
    >
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
            <ArrowLeftRight className="h-4 w-4" strokeWidth={2} />
          </span>
          <h3 className="text-sm font-bold text-foreground">آخر العمليات</h3>
          {items.length > 0 && (
            <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground tabular-nums">
              {items.length}
            </span>
          )}
        </div>
        <Link
          to="/invoices"
          className="rounded text-xs font-medium text-primary transition-colors hover:text-primary-glow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          عرض الكل
        </Link>
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 px-5 py-12 text-muted-foreground">
          <ArrowLeftRight className="h-8 w-8 opacity-50" strokeWidth={1.5} />
          <span className="text-xs">لا توجد عمليات حديثة</span>
        </div>
      ) : (
        <ul className="max-h-[24rem] divide-y divide-border overflow-y-auto">
          {items.map((t, i) => {
            const meta = META[t.type];
            const Icon = meta.icon;
            const isInvoice = t.type === "sale" || t.type === "entry";
            const row = (
              <div className="group relative flex items-center gap-4 px-5 py-4 transition-colors duration-200 hover:bg-secondary/50">
                <div
                  className="pointer-events-none absolute inset-y-0 w-0.5 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
                  style={{ insetInlineStart: 0, background: "var(--primary)" }}
                />
                <div
                  className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg border ${meta.tone}`}
                >
                  <Icon className="h-4 w-4" strokeWidth={2} />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-foreground">
                      {partyOf(t)}
                    </span>
                    <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground tabular-nums">
                      {refOf(t)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{meta.label}</span>
                    <span className="text-border">•</span>
                    <span className="truncate">{detailOf(t)}</span>
                  </div>
                </div>

                <div className="shrink-0 text-left">
                  <span className="font-bold tabular-nums text-foreground">
                    {formatAmount(t.amount, t.currency as Currency)}
                  </span>
                  <div className="mt-0.5 text-start text-[11px] text-muted-foreground">
                    {t.time}
                  </div>
                </div>

                <ChevronLeft className="h-4 w-4 shrink-0 text-primary opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
              </div>
            );
            return (
              <li key={i}>
                {isInvoice ? (
                  <Link
                    to="/invoices/$id"
                    params={{ id: t.id }}
                    className="block outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    {row}
                  </Link>
                ) : (
                  row
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
