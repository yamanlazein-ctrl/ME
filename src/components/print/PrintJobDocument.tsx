import {
  PrintDocument,
  PrintTable,
  type PrintColumn,
  type PrintMetaItem,
} from "@/components/print/PrintDocument";
import { currencySymbol } from "@/presentation/hooks/useCurrency";
import { colorById, fabricById, rollById } from "@/presentation/hooks/useInventory";
import type { PrintJobDTO } from "@/application/ports/IPrintJobRepository";
import { formatNumber, formatMoney, formatQuantity } from "@/shared/utils/formatNumber";


const statusLabel = (j: PrintJobDTO) => (j.status === "received" ? "مستلم" : "مرسل إلى المطبعة");

export function PrintJobDocument({ job }: { job: PrintJobDTO }) {
  const fab = fabricById(job.sourceFabricId);
  const col = colorById(job.sourceColorId);
  const roll = rollById(job.sourceRollId);
  const suit = roll && fab && col;
  const sym = job.currency ? currencySymbol(job.currency as never) : "";

  const meta: PrintMetaItem[] = [
    { label: "الرقم", value: job.number },
    { label: "تاريخ الإرسال", value: job.sentDate },
    { label: "الحالة", value: statusLabel(job) },
    { label: "المطبعة", value: job.pressName },
  ];

  const headers: Partial<PrintColumn>[] = [
    { key: "fabric", label: "القماش" },
    { key: "color", label: "اللون" },
    { key: "roll", label: "الصبغة المصدر" },
    { key: "sentKg", label: "الكمية المرسلة (كغ)", align: "center" },
  ];

  const rows: (string | number)[][] = [
    [fab?.name ?? "—", col?.name ?? "—", roll ? `#${roll.rollNo}` : "—", String(job.sentKg)],
  ];

  const totals: { label: string; value: string; grand?: boolean }[] = [];
  if (job.status === "received" && job.printCostPerKg != null) {
    const cost = job.receivedKg != null ? job.printCostPerKg * job.receivedKg : job.printCostPerKg;
    totals.push({ label: "تكلفة الطباعة (كغ)", value: `${job.printCostPerKg} ${sym}` });
    totals.push({
      label: "إجمالي تكلفة الطباعة",
      value: `${formatMoney(cost)} ${sym}`,
      grand: true,
    });
  }

  return (
    <PrintDocument
      title="سند طباعة — إرسال إلى المطبعة"
      subtitle={job.notes ?? undefined}
      meta={meta}
      totals={totals.length ? totals : undefined}
      notes={job.receiveNotes ?? undefined}
      signatures={["توقيع المطبعة", "ختم الشركة"]}
    >
      <PrintTable columns={headers as PrintColumn[]} rows={rows} />
    </PrintDocument>
  );
}
