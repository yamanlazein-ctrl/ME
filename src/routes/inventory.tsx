import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Search, CheckSquare, X } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import {
  colorsOfFabric,
  deleteColor,
  deleteFabric,
  deleteRoll,
  deleteColors,
  deleteFabrics,
  deleteRolls,
  colorById,
  rollById,
  rollsOfColor,
  useInventory,
  fabrics,
  totalKgOfFabric,
  totalPiecesOfFabric,
} from "@/presentation/hooks/useInventory";
import { FabricRow, ColorRow, RollRow } from "@/components/inventory/InventoryRows";
import {
  FabricFormDialog,
  ColorFormDialog,
  RollFormDialog,
  type FabricFormState,
  type ColorFormState,
  type RollFormState,
} from "@/components/inventory/InventoryDialogs";
import {
  ConfirmDelete,
  type DeleteTarget,
  type BulkDeleteItem,
} from "@/components/inventory/ConfirmDelete";
import { Button } from "@/components/ui/button";
import { DataPagination } from "@/components/common/DataPagination";
import { formatNumber } from "@/shared/utils/formatNumber";

export const Route = createFileRoute("/inventory")({
  component: InventoryPage,
});

function InventoryPage() {
  useInventory();
  const [query, setQuery] = useState("");
  const [expandedFabric, setExpandedFabric] = useState<string | null>(fabrics[0]?.id ?? null);
  const [expandedColor, setExpandedColor] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<DeleteTarget>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Record<string, BulkDeleteItem>>({});
  const [fabForm, setFabForm] = useState<FabricFormState>({ open: false });
  const [colForm, setColForm] = useState<ColorFormState>({ open: false, fabricId: "" });
  const [rolForm, setRolForm] = useState<RollFormState>({ open: false, colorId: "" });

  // Pagination: hard cap of 10 items per page (task spec forbids unbounded lists).
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);

  const q = query.trim().toLowerCase();
  const filteredFabrics = useMemo(() => {
    if (!q) return fabrics;
    return fabrics.filter((f) => {
      if (f.name.toLowerCase().includes(q)) return true;
      return colorsOfFabric(f.id).some((c) => {
        if (c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q)) return true;
        return rollsOfColor(c.id).some(
          (r) => r.rollNo.toLowerCase().includes(q) || r.dyeBatch.toLowerCase().includes(q),
        );
      });
    });
  }, [q, fabrics.length]);

  // Reset to the first page whenever the search term changes.
  useEffect(() => {
    setPage(0);
  }, [q]);

  const pageCount = Math.max(1, Math.ceil(filteredFabrics.length / pageSize));
  const clampedPage = Math.min(page, pageCount - 1);
  const pagedFabrics = filteredFabrics.slice(
    clampedPage * pageSize,
    clampedPage * pageSize + pageSize,
  );

  const selectedItems = Object.values(selected);
  const selectionCount = selectedItems.length;

  const selKey = (item: BulkDeleteItem) => `${item.kind}:${item.id}`;

  const toggleSelect = (item: BulkDeleteItem) => {
    setSelected((prev) => {
      const key = selKey(item);
      const next = { ...prev };
      if (next[key]) {
        delete next[key];
      } else {
        next[key] = item;
      }
      return next;
    });
  };

  const clearSelection = () => {
    setSelected({});
  };

  const enterSelectMode = () => setSelectMode(true);

  const exitSelectMode = () => {
    setSelectMode(false);
    clearSelection();
  };

  const selectAllVisible = () => {
    setSelected((prev) => {
      const next = { ...prev };
      filteredFabrics.forEach((f) => {
        next[`fabric:${f.id}`] = { kind: "fabric", id: f.id, name: f.name };
        colorsOfFabric(f.id).forEach((c) => {
          next[`color:${c.id}`] = { kind: "color", id: c.id, name: `${c.name} — ${c.code}` };
          rollsOfColor(c.id).forEach((r) => {
            next[`roll:${r.id}`] = { kind: "roll", id: r.id, name: `#${r.rollNo}` };
          });
        });
      });
      return next;
    });
  };

  const requestBulkDelete = () => {
    if (selectionCount === 0) return;
    setToDelete({ kind: "bulk", items: selectedItems });
  };

  const handleDelete = () => {
    if (!toDelete) return;
    if (toDelete.kind === "bulk") {
      const items = toDelete.items;
      const fabricIds = items.filter((i) => i.kind === "fabric").map((i) => i.id);
      const fabricSet = new Set(fabricIds);

      // Skip colors already covered by a selected fabric (the fabric delete cascades).
      const colorIds = items
        .filter((i) => i.kind === "color")
        .map((i) => {
          const c = colorById(i.id);
          return c && fabricSet.has(c.fabricId) ? null : i.id;
        })
        .filter((x): x is string => x !== null);
      const colorSet = new Set(colorIds);

      // Skip rolls already covered by a selected fabric or color (cascade).
      const rollIds = items
        .filter((i) => i.kind === "roll")
        .map((i) => {
          const r = rollById(i.id);
          if (!r) return i.id;
          const c = colorById(r.colorId);
          if (c && fabricSet.has(c.fabricId)) return null;
          if (c && colorSet.has(c.id)) return null;
          return i.id;
        })
        .filter((x): x is string => x !== null);

      if (fabricIds.length > 0) void deleteFabrics(fabricIds);
      if (colorIds.length > 0) void deleteColors(colorIds);
      if (rollIds.length > 0) void deleteRolls(rollIds);
      setToDelete(null);
      exitSelectMode();
      return;
    }
    if (toDelete.kind === "fabric") deleteFabric(toDelete.id);
    else if (toDelete.kind === "color") deleteColor(toDelete.id);
    else deleteRoll(toDelete.id);
    setToDelete(null);
  };

  return (
    <AppShell
      title="المخزون"
      subtitle="شجرة الأقمشة والألوان والصبغات — جميع الكميات محسوبة بالكيلوغرام."
      actions={
        <div className="flex items-center gap-2">
          {!selectMode ? (
            <Button variant="outline" size="sm" onClick={enterSelectMode} className="gap-2">
              <CheckSquare className="h-4 w-4" /> حذف متعدد
            </Button>
          ) : (
            <>
              <span className="text-sm font-semibold text-foreground tabular-nums">
                {selectionCount} محدد
              </span>
              <Button variant="outline" size="sm" onClick={selectAllVisible}>
                تحديد الكل
              </Button>
              <Button
                variant="destructive"
                size="sm"
                disabled={selectionCount === 0}
                onClick={requestBulkDelete}
              >
                حذف المحدد
              </Button>
              <Button variant="ghost" size="sm" onClick={exitSelectMode} title="إلغاء التحديد">
                <X className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      }
    >
      <div className="rounded-xl border border-border bg-card p-3 shadow-soft">
        <div className="relative">
          <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="ابحث باسم القماش، اللون، رقم اللون، أو رقم الصبغة..."
            className="h-10 w-full rounded-lg border border-border bg-background pr-10 pl-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition"
          />
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card shadow-soft overflow-hidden">
        {filteredFabrics.length === 0 && (
          <div className="px-6 py-12 text-center text-sm text-muted-foreground">
            لا نتائج مطابقة للبحث.
          </div>
        )}
        <ul className="divide-y divide-border max-h-[65vh] overflow-y-auto">
          {pagedFabrics.map((f) => {
            const isOpen = expandedFabric === f.id || !!q;
            return (
              <li key={f.id}>
                <FabricRow
                  fabric={f}
                  open={isOpen}
                  onToggle={() => setExpandedFabric((cur) => (cur === f.id ? null : f.id))}
                  onEdit={() => setFabForm({ open: true, editing: f })}
                  onDelete={() => setToDelete({ kind: "fabric", id: f.id, name: f.name })}
                  onAddColor={() => setColForm({ open: true, fabricId: f.id })}
                  selectable={selectMode}
                  selected={!!selected[selKey({ kind: "fabric", id: f.id, name: f.name })]}
                  onSelect={() => toggleSelect({ kind: "fabric", id: f.id, name: f.name })}
                />
                {isOpen && (
                  <>
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-border bg-background/60 px-4 py-2 text-[11px] text-muted-foreground tabular-nums">
                      <span>
                        باقي <b className="font-bold text-primary">{totalPiecesOfFabric(f.id)}</b>{" "}
                        أثواب
                      </span>
                      <span>•</span>
                      <span>
                        إجمالي المتبقي{" "}
                        <b className="font-bold text-foreground">
                          {formatNumber(totalKgOfFabric(f.id))}
                        </b>{" "}
                        كغ
                      </span>
                      <span>•</span>
                      <span>{colorsOfFabric(f.id).length} لون</span>
                    </div>
                    <ul className="bg-secondary/30">
                      {colorsOfFabric(f.id).map((c) => {
                        const colorOpen = expandedColor === c.id || !!q;
                        return (
                          <li key={c.id}>
                            <ColorRow
                              color={c}
                              open={colorOpen}
                              onToggle={() =>
                                setExpandedColor((cur) => (cur === c.id ? null : c.id))
                              }
                              onEdit={() => setColForm({ open: true, fabricId: f.id, editing: c })}
                              onDelete={() =>
                                setToDelete({ kind: "color", id: c.id, name: c.name })
                              }
                              onAddRoll={() => setRolForm({ open: true, colorId: c.id })}
                              selectable={selectMode}
                              selected={
                                !!selected[
                                  selKey({ kind: "color", id: c.id, name: `${c.name} — ${c.code}` })
                                ]
                              }
                              onSelect={() =>
                                toggleSelect({
                                  kind: "color",
                                  id: c.id,
                                  name: `${c.name} — ${c.code}`,
                                })
                              }
                            />
                            {colorOpen && (
                              <ul>
                                {rollsOfColor(c.id).map((r) => (
                                  <li key={r.id}>
                                    <RollRow
                                      roll={r}
                                      minKg={f.minStockKg ?? 0}
                                      onEdit={() =>
                                        setRolForm({ open: true, colorId: c.id, editing: r })
                                      }
                                      onDelete={() =>
                                        setToDelete({
                                          kind: "roll",
                                          id: r.id,
                                          name: `#${r.rollNo}`,
                                        })
                                      }
                                      selectable={selectMode}
                                      selected={
                                        !!selected[
                                          selKey({ kind: "roll", id: r.id, name: `#${r.rollNo}` })
                                        ]
                                      }
                                      onSelect={() =>
                                        toggleSelect({
                                          kind: "roll",
                                          id: r.id,
                                          name: `#${r.rollNo}`,
                                        })
                                      }
                                    />
                                  </li>
                                ))}
                              </ul>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </li>
            );
          })}
        </ul>

        {filteredFabrics.length > 0 && (
          <DataPagination
            total={filteredFabrics.length}
            page={clampedPage}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(s) => {
              setPageSize(s);
              setPage(0);
            }}
            pageSizeOptions={[5, 10]}
          />
        )}
      </div>

      <ConfirmDelete
        target={toDelete}
        onCancel={() => setToDelete(null)}
        onConfirm={handleDelete}
      />
      <FabricFormDialog state={fabForm} onClose={() => setFabForm({ open: false })} />
      <ColorFormDialog state={colForm} onClose={() => setColForm({ open: false, fabricId: "" })} />
      <RollFormDialog state={rolForm} onClose={() => setRolForm({ open: false, colorId: "" })} />
    </AppShell>
  );
}
