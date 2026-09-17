import { ColorSwatch } from "@/components/common/ColorSwatch";
import { colorById } from "@/presentation/hooks/useInventory";

/**
 * Print colour cell — swatch + name + code on one line so the column
 * does not wrap into a stacked block on A4.
 */
export function PrintColorCell({ colorId }: { colorId?: string | null }) {
  if (!colorId) {
    return <span className="pd-color-missing">—</span>;
  }
  const col = colorById(colorId);
  if (!col) {
    return <span className="pd-color-missing">—</span>;
  }

  const code = (col.code ?? "").trim();
  const name = (col.name ?? "").trim();

  return (
    <div className="pd-color-cell" data-color-id={colorId}>
      <ColorSwatch color={col} size="sm" className="pd-color-swatch" />
      <span className="pd-color-label">
        {name || "—"}
        {code ? <span className="pd-color-code"> {code}</span> : null}
      </span>
    </div>
  );
}
