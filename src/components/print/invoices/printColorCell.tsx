import { ColorSwatch } from "@/components/common/ColorSwatch";
import { colorById } from "@/presentation/hooks/useInventory";

/**
 * Print colour cell — circle swatch + name + code kept as separate flex
 * items so a long code never eats the name (and vice versa).
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
      <span className="pd-color-name">{name || "—"}</span>
      {code ? (
        <span className="pd-color-code" dir="ltr">
          {code}
        </span>
      ) : null}
    </div>
  );
}
