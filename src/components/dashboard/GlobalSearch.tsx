import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Search } from "lucide-react";
import { useState, useMemo, useEffect, useRef } from "react";

import { Link } from "@tanstack/react-router";
import { customers, suppliers } from "@/presentation/hooks/useParties";
import { fabrics, rolls, colorById, fabricById } from "@/presentation/hooks/useInventory";
import { useInvoicesList } from "@/presentation/hooks/useInvoices";
import { useVouchersList } from "@/presentation/hooks/useVouchers";
import { useExpensesList } from "@/presentation/hooks/useExpenses";
import { useReturnsList } from "@/presentation/hooks/useReturns";

type Hit = { group: string; label: string; sub?: string; to: string };

export function GlobalSearch() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: invoicesData } = useInvoicesList();
  const { data: vouchersData } = useVouchersList();
  const { data: expensesData } = useExpensesList();
  const { data: returnsData } = useReturnsList();

  const invoices = useMemo(() => invoicesData?.data ?? [], [invoicesData?.data]);
  const vouchers = useMemo(() => vouchersData?.data ?? [], [vouchersData?.data]);
  const expenses = useMemo(() => expensesData ?? [], [expensesData]);
  const returns = useMemo(() => returnsData?.data ?? [], [returnsData?.data]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const results = useMemo<Hit[]>(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const hits: Hit[] = [];
    for (const c of customers)
      if (c.name.toLowerCase().includes(s) || c.code?.toLowerCase().includes(s))
        hits.push({ group: "عملاء", label: c.name, sub: c.code, to: `/customers/${c.id}` });
    for (const c of suppliers)
      if (c.name.toLowerCase().includes(s) || c.code?.toLowerCase().includes(s))
        hits.push({ group: "موردون", label: c.name, sub: c.code, to: `/suppliers/${c.id}` });
    for (const i of invoices)
      if (i.number.toLowerCase().includes(s))
        hits.push({ group: "فواتير", label: i.number, sub: i.type, to: `/invoices/${i.id}` });
    for (const v of vouchers)
      if (v.number.toLowerCase().includes(s))
        hits.push({
          group: "سندات",
          label: v.number,
          sub: v.kind === "receipt" ? "قبض" : "صرف",
          to: v.kind === "receipt" ? "/receipts" : "/payments",
        });
    for (const e of expenses)
      if (
        e.number.toLowerCase().includes(s) ||
        e.description.toLowerCase().includes(s) ||
        e.category.toLowerCase().includes(s)
      )
        hits.push({ group: "مصاريف", label: e.number, sub: e.category, to: "/expenses" });
    for (const r of returns)
      if (r.number.toLowerCase().includes(s))
        hits.push({
          group: "مرتجعات",
          label: r.number,
          sub: r.kind === "entry" ? "دخول" : "بيع",
          to: "/returns",
        });
    for (const f of fabrics)
      if (f.name.toLowerCase().includes(s))
        hits.push({
          group: "أقمشة",
          label: f.name,
          sub: f.category ?? undefined,
          to: "/inventory",
        });
    for (const r of rolls)
      if ((r.rollNo ?? "").includes(s) || (r.dyeBatch ?? "").toLowerCase().includes(s)) {
        const c = colorById(r.colorId);
        const f = c && fabricById(c.fabricId);
        hits.push({
          group: "صبغات",
          label: `#${r.rollNo}`,
          sub: `${f?.name ?? ""} — ${c?.name ?? ""}`,
          to: "/inventory",
        });
      }
    return hits.slice(0, 60);
  }, [q, invoices, vouchers, expenses, returns]);

  const grouped = useMemo(() => {
    const m = new Map<string, Hit[]>();
    for (const h of results) {
      if (!m.has(h.group)) m.set(h.group, []);
      m.get(h.group)!.push(h);
    }
    return [...m.entries()];
  }, [results]);

  return (
    <Popover open={open && !!q} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div
          className={`relative mx-auto transition-all duration-300 ease-out ${
            open || q ? "w-full max-w-[520px]" : "w-full max-w-[280px]"
          }`}
        >
          <Search className="pointer-events-none absolute right-3 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-muted-foreground/70" />
          <input
            ref={inputRef}
            type="text"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            placeholder="ابحث..."
            className="h-9 w-full rounded-full border border-border/70 bg-card pr-10 pl-4 text-sm text-foreground placeholder:text-muted-foreground/60 outline-none focus:border-primary focus:ring-2 focus:ring-primary/30 transition-all duration-300"
          />
        </div>
      </PopoverTrigger>
      <PopoverContent
        align="center"
        side="bottom"
        sideOffset={8}
        className="z-50 w-[520px] p-0 max-h-[480px] overflow-y-auto rounded-xl border border-border bg-popover shadow-elevated"
        dir="rtl"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {grouped.length === 0 && (
          <div className="p-4 text-center text-xs text-muted-foreground">لا نتائج.</div>
        )}
        {grouped.map(([group, items]) => (
          <div key={group}>
            <div className="sticky top-0 bg-secondary/80 px-3 py-1.5 text-[10px] font-bold uppercase text-muted-foreground">
              {group}
            </div>
            {items.map((h, i) => (
              <Link
                key={i}
                to={h.to}
                onClick={() => {
                  setOpen(false);
                  setQ("");
                }}
                className="flex justify-between px-3 py-2 hover:bg-primary/10 text-sm"
              >
                <span className="text-foreground">{h.label}</span>
                {h.sub && <span className="text-xs text-muted-foreground">{h.sub}</span>}
              </Link>
            ))}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}
