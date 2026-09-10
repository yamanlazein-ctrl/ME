import { ColorSwatch } from "@/components/common/ColorSwatch";
import { colorById } from "@/presentation/hooks/useInventory";

/**
 * Print colour cell — same identity as inventory:
 *   circular swatch (hex) + كود {code} + name
 *
 * Always resolves via colorById(colorId) from the inventory cache.
 * Print portal MUST await refreshInventory() before rendering so every
 * line gets its own colour (never a shared/stale blank).
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
      <div className="pd-color-text">
        {code ? <div className="pd-color-code">كود {code}</div> : null}
        <div className="pd-color-name">{name || "—"}</div>
      </div>
    </div>
  );
}
