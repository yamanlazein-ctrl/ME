// T132 (NFR-09, G4): every touchable of the rendered screens has an accessibility label (or text) and is at least 48 dp high.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react-native";
import type { ReactElement } from "react";
import { flat } from "../helpers/style";
import { MIN_TOUCH } from "../../src/ui/theme-const";
import { emptyEntryDraft } from "../../src/core/entryDraft";
import { emptyReturnDraft } from "../../src/core/returns";
import { emptyPartyForm } from "../../src/ui/PartyViews";
import {
  CountSheetView,
  FabricDetailView,
  FabricListView,
  RollDetailView,
} from "../../src/ui/InventoryViews";
import { ReportMenuView, ReportPageView } from "../../src/ui/ReportViews";
import { OrderDetailView, OrderFormView, OrderListView } from "../../src/ui/OrderViews";
import { ReturnFormView, ReturnListView } from "../../src/ui/ReturnViews";
import {
  EntryDoneView,
  EntryLinesView,
  EntryReviewView,
  EntrySupplierView,
} from "../../src/ui/EntryViews";
import { AddMenu } from "../../src/ui/AddMenu";
import { PhonePrompt } from "../../src/ui/PhonePrompt";
import { PartyFormView, PartyListView } from "../../src/ui/PartyViews";
import { ScanDenied, ScanOverlay } from "../../src/ui/ScanView";
import { UpdateOfferBanner } from "../../src/ui/UpdateBanner";

vi.mock("../../src/hooks/useParties", () => ({ useParties: () => ({ data: [] }) }));

type Node = {
  type?: string;
  props?: Record<string, unknown>;
  children?: Array<Node | string> | null;
};

function textOf(node: Node | string | null | undefined): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  return (node.children ?? []).map(textOf).join("");
}

/** Every pressable in the tree: its label and its minimum height. */
function touchables(
  node: Node | string | null | undefined,
  out: Array<{ label: string; minHeight: number }> = [],
) {
  if (!node || typeof node === "string") return out;
  const props = node.props ?? {};
  if (typeof props.onPress === "function" || node.type === "Pressable") {
    const style = flat(props.style);
    out.push({
      label: String(props.accessibilityLabel ?? textOf(node)),
      minHeight: Number(style.minHeight ?? style.height ?? 0),
    });
  }
  for (const c of node.children ?? []) touchables(c, out);
  return out;
}

const noop = () => undefined;

const screens: Array<[string, () => ReactElement]> = [
  ["add menu", () => <AddMenu onOpen={noop} />],
  ["report menu", () => <ReportMenuView onOpen={noop} />],
  [
    "report page",
    () => (
      <ReportPageView
        page={{ slug: "x", title: "t", figures: [], lines: [], total: 0 }}
        period="all"
        error={null}
        onPeriod={noop}
      />
    ),
  ],
  [
    "fabric list",
    () => (
      <FabricListView
        rows={[{ id: "f", name: "قطن", minStockKg: 50, remainingKg: 32, rollCount: 1, low: true }]}
        q=""
        role="admin"
        onQuery={noop}
        onOpen={noop}
        onCount={noop}
      />
    ),
  ],
  [
    "fabric detail",
    () => (
      <FabricDetailView
        name="قطن"
        rows={[{ id: "c", name: "أحمر", code: null, remainingKg: 5, rollCount: 1 }]}
        rollsOf={() => null}
        onOpenRoll={noop}
      />
    ),
  ],
  [
    "roll detail",
    () => (
      <RollDetailView
        detail={{
          roll: {
            id: "r",
            rollNo: "R1",
            remainingKg: 5,
            remainingPieces: 1,
            pricePerKg: 2,
            currency: "USD",
            status: "in_stock",
            version: 1,
            initialKg: 5,
            entryDate: "2026-01-01",
            dyeBatch: null,
          },
          fabricName: "ق",
          colorName: "ل",
          movements: [],
        }}
        role="admin"
        error={null}
        busy={false}
        onAdjust={noop}
      />
    ),
  ],
  [
    "count sheet",
    () => (
      <CountSheetView
        lines={[
          {
            rollId: "r",
            countId: "c",
            rollNo: "R1",
            fabricName: "ق",
            colorName: "ل",
            bookKg: 5,
            countedKg: 4,
            diffKg: -1,
            status: "counted",
          },
        ]}
        total={1}
        q=""
        error={null}
        notice={null}
        onQuery={noop}
        onRecord={noop}
        onPost={noop}
      />
    ),
  ],
  [
    "orders",
    () => (
      <OrderListView
        rows={[
          {
            id: "o",
            code: "ORD-1",
            customer: "ع",
            date: "d",
            status: "open",
            version: 1,
            totalKg: 1,
          },
        ]}
        canWrite
        onOpen={noop}
        onNew={noop}
      />
    ),
  ],
  [
    "order form",
    () => (
      <OrderFormView
        customer={{ id: "p", name: "عميل" }}
        items={[{ key: "k", fabricName: "ق", colorName: "ل", requestedKg: 1 }]}
        busy={false}
        error={null}
        onCustomer={noop}
        onAddItem={noop}
        onRemoveItem={noop}
        onSave={noop}
      />
    ),
  ],
  [
    "order detail",
    () => (
      <OrderDetailView
        detail={{
          order: {
            id: "o",
            code: "ORD-1",
            customerNameSnapshot: "ع",
            date: "d",
            status: "open",
            version: 1,
            items: [],
          } as never,
          conflicts: [],
        }}
        canWrite
        candidates={[{ id: "i", number: "INV-1", date: "d" }]}
        error={null}
        onCancel={noop}
        onFulfil={noop}
      />
    ),
  ],
  [
    "return form",
    () => (
      <ReturnFormView
        draft={{
          ...emptyReturnDraft("sale"),
          party: { id: "p", name: "عميل" },
          invoice: { id: "i", number: "INV-1", date: "d", total: 1, currency: "USD" },
          lines: [{ rollId: "r", label: "ق · ل · R1", soldKg: 5, pieces: 1, pricePerKg: 2 }],
        }}
        invoices={[{ id: "i", number: "INV-1", date: "d", total: 1, currency: "USD" }]}
        busy={false}
        error={null}
        onKind={noop}
        onParty={noop}
        onInvoice={noop}
        onQty={noop}
        onReason={noop}
        onSave={noop}
      />
    ),
  ],
  [
    "return list",
    () => (
      <ReturnListView
        rows={[
          {
            id: "r",
            number: "RET-1",
            kind: "sale",
            date: "d",
            status: "active",
            version: 1,
            total: 1,
            currency: "USD",
          },
        ]}
        canCancel
        error={null}
        onCancel={noop}
      />
    ),
  ],
  [
    "entry supplier",
    () => (
      <EntrySupplierView
        draft={{ ...emptyEntryDraft(), supplier: { id: "s", name: "مورد" } }}
        onSupplier={noop}
        onCurrency={noop}
        onRate={noop}
        onNext={noop}
      />
    ),
  ],
  [
    "entry lines",
    () => (
      <EntryLinesView
        draft={{
          ...emptyEntryDraft(),
          lines: [
            { key: "k", fabricName: "ق", colorName: "ل", quantityKg: 1, pieces: 1, pricePerKg: 1 },
          ],
        }}
        adding={false}
        form={null}
        onAdd={noop}
        onRemove={noop}
        onNext={noop}
      />
    ),
  ],
  [
    "entry review",
    () => (
      <EntryReviewView
        draft={emptyEntryDraft()}
        busy={false}
        error={null}
        onPatch={noop}
        onSave={noop}
      />
    ),
  ],
  ["entry done", () => <EntryDoneView number="ENT-1" onOpen={noop} onNew={noop} />],
  [
    "phone prompt",
    () => (
      <PhonePrompt
        partyName="ع"
        value=""
        save
        busy={false}
        error={null}
        onChange={noop}
        onToggleSave={noop}
        onSend={noop}
        onCancel={noop}
      />
    ),
  ],
  [
    "party list",
    () => (
      <PartyListView
        rows={[{ id: "p", name: "ع", kind: "customer", code: "C1" }]}
        q=""
        kind=""
        role="admin"
        onQuery={noop}
        onKind={noop}
        onOpen={noop}
        onNew={noop}
      />
    ),
  ],
  [
    "party form with opening balance",
    () => (
      <PartyFormView
        values={emptyPartyForm()}
        showOpening
        error={null}
        busy={false}
        onChange={noop}
        onSave={noop}
      />
    ),
  ],
  ["scan overlay", () => <ScanOverlay message="m" rejected={false} onCancel={noop} />],
  ["scan denied", () => <ScanDenied onCancel={noop} />],
  [
    "update offer",
    () => (
      <UpdateOfferBanner
        offer={{ versionName: "1.2.0", apkUrl: "u", required: false }}
        onOpen={noop}
      />
    ),
  ],
];

describe("every touchable has a label and is at least 48 dp (NFR-09)", () => {
  for (const [name, build] of screens) {
    it(name, async () => {
      await render(build());
      const found = touchables(screen.toJSON() as unknown as Node);
      expect(found.length, `${name} renders no touchable`).toBeGreaterThan(0);
      for (const t of found) {
        expect(t.label.trim().length, `${name}: a touchable has no label`).toBeGreaterThan(0);
        expect(
          t.minHeight,
          `${name}: "${t.label}" is below ${MIN_TOUCH} dp`,
        ).toBeGreaterThanOrEqual(MIN_TOUCH);
      }
    });
  }
});
