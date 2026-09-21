import { createFileRoute, Link, notFound, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Ban, Pencil, Printer, XCircle, Plus } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { ColorSwatch } from "@/components/common/ColorSwatch";
import { PageCard } from "@/components/layout/PageCard";
import { useCancelInvoice, useInvoice } from "@/presentation/hooks/useInvoices";
import { currencySymbol } from "@/presentation/hooks/useCurrency";
import type { Currency } from "@/domain/types";
import { colorById, fabricById, rollById, useInventory } from "@/presentation/hooks/useInventory";
import { customerById, supplierById } from "@/presentation/hooks/useParties";
import { useVouchersList } from "@/presentation/hooks/useVouchers";
import { printDocument, printOrArchive } from "@/components/print/printPortal";
import { archiveMeta } from "@/shared/utils/documentArchive";
import { InvoicePrintDocument } from "@/components/print/InvoicePrintDocument";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatNumber, formatMoney, formatQuantity } from "@/shared/utils/formatNumber";
import { convertForSettlement } from "@erp/shared";

export const Route = createFileRoute("/invoices/$id")({
  component: InvoiceDetailPage,
});

const TYPE_LABEL = {
  entry: "فاتورة الدخول",
  sale: "فاتورة بيع",
  return: "فاتورة مرتجع",
} as const;

function InvoiceDetailPage() {
  useInventory();
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { data: inv } = useInvoice(id);
  const { data: vouchersData } = useVouchersList();
  const allVouchers = vouchersData?.data ?? [];
  const cancel = useCancelInvoice();
  const [confirm1Open, setConfirm1Open] = useState(false);
  const [confirm2Open, setConfirm2Open] = useState(false);

  if (!inv) {
    return (
      <AppShell title="غير موجودة">
        <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          الفاتورة غير موجودة.
        </div>
      </AppShell>
    );
  }

  const total = inv.total();
  const paid = inv.paid ?? 0;
  const remaining = Math.max(0, total - paid);
  const linkedVouchers = allVouchers.filter((v) => v.invoiceId === inv.id && v.status === "active");
  const party =
    inv.partyType === "customer" ? customerById(inv.partyId) : supplierById(inv.partyId);
  const partyRoute = inv.partyType === "customer" ? "/customers/$id" : "/suppliers/$id";
  const voucherKind = inv.partyType === "customer" ? "receipts" : "payments";
  const paidLabel = inv.partyType === "customer" ? "المقبوض" : "المدفوع للمورد";
  const remainingLabel = inv.partyType === "customer" ? "الباقي عليك" : "الباقي للمورد";
  const isCancelled = inv.status === "cancelled";

  return (
    <AppShell
      title={`${TYPE_LABEL[inv.type]} — ${inv.reference || inv.number}`}
      subtitle={isCancelled ? "⛔ هذه الفاتورة ملغاة" : `التاريخ: ${inv.date}`}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            className="gap-2"
            onClick={() => {
              const node = <InvoicePrintDocument invoice={inv} />;
              if (inv.type === "sale" || inv.type === "entry") {
                printOrArchive(
                  node,
                  archiveMeta(inv.type, {
                    date: inv.date,
                    typeLabel: inv.type === "entry" ? "ENTRY" : "SALE",
                    number: inv.number || inv.reference || inv.id,
                  }),
                  true,
                );
              } else {
                printDocument(node);
              }
            }}
          >
            <Printer className="h-4 w-4" /> طباعة
          </Button>
          <Button
            variant="outline"
            className="gap-2"
            disabled={isCancelled}
            title="فتح نسخة قابلة للتعديل من هذه الفاتورة"
            onClick={() =>
              navigate({
                to: inv.type === "entry" ? "/invoices/entry/new" : "/invoices/sale/new",
                search: { edit: inv.id },
              })
            }
          >
            <Pencil className="h-4 w-4" /> تعديل
          </Button>
          <Button
            variant="outline"
            className="gap-2 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
            disabled={isCancelled}
            onClick={() => setConfirm1Open(true)}
          >
            <Ban className="h-4 w-4" /> إلغاء الفاتورة
          </Button>
        </div>
      }
    >
      {/* Card 1 — Meta */}
      <PageCard title="بيانات الفاتورة" description="المعلومات الأساسية للفاتورة">
        <div className="grid gap-4 md:grid-cols-4">
          <MetaCell label="الرقم المرجعي" value={inv.reference || inv.number} mono />
          <MetaCell label="النوع" value={TYPE_LABEL[inv.type]} />
          <MetaCell label="التاريخ" value={inv.date} mono />
          <MetaCell label="العملة" value={inv.currency === "USD" ? "دولار أمريكي" : "ليرة سورية"} />
          {inv.currency !== "USD" && Number(inv.exchangeRate) > 1 ? (
            <>
              <MetaCell
                label="سعر الصرف"
                value={`${formatNumber(Number(inv.exchangeRate))} · بتاريخ ${inv.date}`}
              />
              <MetaCell
                label="المعادل بالدولار"
                value={`$${formatNumber(Number(inv.baseTotal) || 0)}`}
              />
            </>
          ) : null}
        </div>
        <div className="mt-4 flex items-center justify-between rounded-lg border border-border bg-secondary/30 px-4 py-3">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {inv.partyType === "customer" ? "العميل" : "المورد"}
            </div>
            <Link
              to={partyRoute}
              params={{ id: inv.partyId }}
              className="mt-1 inline-flex items-center gap-2 text-base font-semibold text-primary hover:underline"
            >
              {party?.name ?? "—"}
            </Link>
            {party?.phone && (
              <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">{party.phone}</div>
            )}
          </div>
        </div>
      </PageCard>

      {/* Card 2 — Items */}
      <PageCard title="بنود الفاتورة" description={`${inv.lines.length} بند`} noBodyPadding>
        <div className="overflow-x-auto">
          <table className="w-full text-right text-sm">
            <thead className="sticky top-0 z-[1] bg-secondary/70 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">
              <tr className="[&>th]:px-4 [&>th]:py-3">
                <th>نوع القماش</th>
                <th>اللون / الكود</th>
                <th>الصبغة</th>
                <th className="text-left">الكمية (كغ)</th>
                <th className="text-left">السعر / كغ</th>
                <th className="text-left">الإجمالي</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {inv.lines.map((l) => {
                const fab = fabricById(l.fabricId);
                const col = colorById(l.colorId);
                const roll = rollById(l.rollId);
                return (
                  <tr key={l.id} className="h-12 transition hover:bg-secondary/40">
                    <td className="px-4 py-2 text-foreground">{fab?.name ?? "—"}</td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <ColorSwatch color={col} size="sm" />
                        <span className="truncate">
                          {col?.name} —{" "}
                          <span className="text-muted-foreground tabular-nums">{col?.code}</span>
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-2 tabular-nums">#{roll?.rollNo ?? "—"}</td>
                    <td className="px-4 py-2 text-left tabular-nums">{l.quantityKg}</td>
                    <td className="px-4 py-2 text-left tabular-nums">
                      {formatNumber(l.pricePerKg)} {currencySymbol(inv.currency)}
                    </td>
                    <td className="px-4 py-2 text-left tabular-nums font-semibold">
                      {formatNumber(inv.lineTotal(l))} {currencySymbol(inv.currency)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </PageCard>

      {/* Card 3 — Payment summary */}
      <PageCard
        title="ملخص الدفع"
        description="المقبوض والمتبقي محسوبان تلقائياً من السندات المرتبطة"
        tone="primary"
        actions={
          isCancelled ? (
            // F14 (Phase 1 audit): a cancelled invoice must not offer a path
            // to record a voucher "against" it — creating one here used to
            // land on an empty, unlinked /payments|receipts/new form (no
            // invoiceId support existed at all), letting a user record an
            // unlinked disbursement instead of being stopped, same as Edit
            // and Cancel above are already disabled for a cancelled invoice.
            <Button
              size="sm"
              variant="outline"
              className="h-9 gap-1"
              disabled
              title="الفاتورة ملغاة — لا يمكن إنشاء سند مرتبط بها"
            >
              <Plus className="h-4 w-4" />{" "}
              {inv.partyType === "customer" ? "سند قبض جديد" : "سند صرف جديد"}
            </Button>
          ) : (
            <Link to={`/${voucherKind}/new`} search={{ partyId: inv.partyId, invoiceId: inv.id }}>
              <Button size="sm" variant="outline" className="h-9 gap-1">
                <Plus className="h-4 w-4" />{" "}
                {inv.partyType === "customer" ? "سند قبض جديد" : "سند صرف جديد"}
              </Button>
            </Link>
          )
        }
      >
        {/* Financial breakdown — mirrors the print template exactly
            (audit rule 5): subtotal, invoice discount, tax, shipping. */}
        <div className="mb-3 grid gap-3 md:grid-cols-6">
          <PayCell label="مجموع الأصناف" value={inv.lineSubtotal()} currency={inv.currency} />
          <PayCell label="خصم الفاتورة" value={inv.discount ?? 0} currency={inv.currency} />
          <PayCell label="الضريبة" value={inv.tax ?? 0} currency={inv.currency} />
          <PayCell label="الشحن" value={inv.shipping ?? 0} currency={inv.currency} />
          <PayCell label="الإجمالي الكلي" value={total} currency={inv.currency} />
          <PayCell label="إجمالي المدفوع" value={paid} currency={inv.currency} />
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <PayCell label="الإجمالي" value={total} currency={inv.currency} />
          <PayCell label={paidLabel} value={paid} currency={inv.currency} />
          <PayCell
            label={remainingLabel}
            value={remaining}
            currency={inv.currency}
            tone={remaining > 0 ? "danger" : "neutral"}
          />
        </div>

        {linkedVouchers.length > 0 && (
          <div className="mt-4">
            <div className="mb-2 text-xs font-semibold text-muted-foreground">السندات المرتبطة</div>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {linkedVouchers.map((v) => {
                // Paid in another currency than the invoice: show the rate captured at payment
                // time and the equivalent that reduced the invoice (never the invoice's own rate).
                const equivalent =
                  v.currency !== inv.currency
                    ? convertForSettlement(
                        v.amount,
                        v.currency,
                        inv.currency,
                        v.exchangeRate ?? null,
                      )
                    : null;
                return (
                  <li key={v.id} className="flex items-center justify-between px-3 py-2 text-sm">
                    <span className="text-muted-foreground tabular-nums">
                      {v.number} — {v.date}
                    </span>
                    <span className="text-left">
                      <span className="font-semibold text-foreground tabular-nums">
                        {formatNumber(v.amount)} {currencySymbol(v.currency as Currency)}
                      </span>
                      {equivalent != null && v.exchangeRate ? (
                        <span
                          className="block text-[11px] text-muted-foreground tabular-nums"
                          data-testid="linked-voucher-equivalent"
                        >
                          × {formatNumber(v.exchangeRate)} = {formatNumber(equivalent)}{" "}
                          {currencySymbol(inv.currency as Currency)}
                        </span>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </PageCard>

      {inv.notes && (
        <PageCard title="ملاحظات">
          <div className="text-sm text-foreground">{inv.notes}</div>
        </PageCard>
      )}

      {/* double-confirm cancel */}
      <AlertDialog open={confirm1Open} onOpenChange={setConfirm1Open}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>إلغاء الفاتورة {inv.number}</AlertDialogTitle>
            <AlertDialogDescription>
              هل أنت متأكد من إلغاء هذه الفاتورة؟ سيتم إيقافها محاسبياً.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row-reverse gap-2">
            <AlertDialogAction
              onClick={() => {
                setConfirm1Open(false);
                setConfirm2Open(true);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              نعم، متابعة
            </AlertDialogAction>
            <AlertDialogCancel>تراجع</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirm2Open} onOpenChange={setConfirm2Open}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <XCircle className="h-5 w-5" /> تأكيد نهائي
            </AlertDialogTitle>
            <AlertDialogDescription>
              سيتم تسجيل الفاتورة كملغاة بشكل نهائي. لا يمكن التراجع عن هذا الإجراء بدون إذن خاص.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-row-reverse gap-2">
            <AlertDialogAction
              onClick={async () => {
                await cancel.mutateAsync(inv.id);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              إلغاء الفاتورة نهائياً
            </AlertDialogAction>
            <AlertDialogCancel>تراجع</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppShell>
  );
}

function MetaCell({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className={`mt-1 text-base font-semibold text-foreground ${mono ? "tabular-nums" : ""}`}>
        {value}
      </div>
    </div>
  );
}

function PayCell({
  label,
  value,
  currency,
  tone = "neutral",
}: {
  label: string;
  value: number;
  currency: Currency;
  tone?: "neutral" | "danger";
}) {
  const cls =
    tone === "danger"
      ? "border-destructive/40 bg-destructive/10 text-destructive"
      : "border-border bg-secondary/50 text-foreground";
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`mt-1 flex items-center rounded-lg border px-3 py-2 text-base font-bold tabular-nums ${cls}`}
      >
        {formatQuantity(value)}
        <span className="mr-1 text-xs font-normal opacity-70">{currencySymbol(currency)}</span>
      </div>
    </div>
  );
}
