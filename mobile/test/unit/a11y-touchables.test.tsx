// T132 (NFR-09, G4): every touchable of the rendered screens has an accessibility label (or text) and is at least 48 dp high.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react-native";
import type { ReactElement } from "react";
import { flat } from "../helpers/style";
import { MIN_TOUCH } from "../../src/ui/theme-const";
import { emptyEntryDraft } from "../../src/core/entryDraft";
import { emptyDraft } from "../../src/core/saleDraft";
import { emptyReturnDraft } from "../../src/core/returns";
import { emptyPartyForm } from "../../src/ui/PartyViews";
import {
  ColorLotsView,
  CountSheetView,
  FabricView,
  LotView,
  StockListView,
} from "../../src/ui/InventoryViews";
import { ReportMenuView, ReportPageView } from "../../src/ui/ReportViews";
import { OrderDetailView, OrderFormView, OrderListView } from "../../src/ui/OrderViews";
import { ReturnFormView, ReturnListView } from "../../src/ui/ReturnViews";
import { EntryFormView } from "../../src/ui/EntryViews";
import { DocumentDoneView, SaleFormView } from "../../src/ui/SaleViews";
import { VoucherForm, emptyVoucher } from "../../src/ui/VoucherForm";
import { withQuery } from "../helpers/withQuery";
import { AddMenu } from "../../src/ui/AddMenu";
import { LoginView } from "../../src/ui/LoginView";
import { PartyDetailView, PartyFormView, PartyListView } from "../../src/ui/PartyViews";
import { ScanDenied, ScanOverlay } from "../../src/ui/ScanView";
import { UpdateOfferBanner } from "../../src/ui/UpdateBanner";

vi.mock("../../src/hooks/useParties", () => ({ usePartyList: () => ({ data: [] }) }));

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
    "stock list",
    () => (
      <StockListView
        q="DL"
        filter="all"
        category={null}
        categories={["قمصان"]}
        rows={[
          {
            id: "f",
            name: "قطن",
            category: null,
            unit: "kg",
            minStockKg: 50,
            remainingKg: 32,
            pieces: 1,
            activeLots: 1,
            colorCount: 1,
            low: true,
          },
        ]}
        lots={[
          {
            id: "r",
            rollNo: "DL-1",
            fabricId: "f",
            fabricName: "قطن",
            colorName: "ل",
            remainingKg: 1,
            remainingPieces: 1,
          },
        ]}
        loading={false}
        error={null}
        refreshing={false}
        canCount
        onQuery={noop}
        onFilter={noop}
        onCategory={noop}
        onRefresh={noop}
        onRetry={noop}
        onOpenFabric={noop}
        onOpenLot={noop}
        onCount={noop}
      />
    ),
  ],
  [
    "fabric",
    () => (
      <FabricView
        detail={{
          fabric: {
            id: "f",
            name: "قطن",
            category: null,
            unit: "kg",
            minStockKg: 0,
            remainingKg: 5,
            pieces: 1,
            activeLots: 1,
            colorCount: 1,
            low: false,
            notes: null,
          },
          colors: [
            {
              id: "c",
              name: "أحمر",
              code: null,
              hex: null,
              remainingKg: 5,
              pieces: 1,
              activeLots: 1,
              totalLots: 1,
            },
          ],
        }}
        onOpenColor={noop}
      />
    ),
  ],
  [
    "colour lots",
    () => (
      <ColorLotsView
        data={{
          fabricId: "f",
          fabricName: "ق",
          fabricMinKg: 0,
          colorName: "ل",
          colorCode: null,
          hex: null,
          lots: [
            {
              id: "r",
              rollNo: "R1",
              dyeBatch: null,
              initialKg: 5,
              remainingKg: 5,
              remainingPieces: 1,
              pieces: 1,
              supplierName: null,
              entryDate: null,
              state: "active",
            },
          ],
        }}
        onOpenLot={noop}
      />
    ),
  ],
  [
    "lot",
    () => (
      <LotView
        lot={{
          id: "r",
          rollNo: "R1",
          version: 1,
          fabricId: "f",
          fabricName: "ق",
          colorId: "c",
          colorName: "ل",
          colorCode: null,
          dyeBatch: null,
          initialKg: 5,
          remainingKg: 5,
          outKg: 0,
          pieces: 1,
          remainingPieces: 1,
          widthCm: null,
          weightGsm: null,
          salePricePerKg: null,
          costPerKg: 2,
          currency: "USD",
          entryPricePerKg: null,
          entryCurrency: null,
          supplierName: null,
          entryDate: null,
          entryReference: null,
          state: "active",
          movements: [
            {
              id: "m",
              label: "فاتورة بيع",
              direction: "out",
              quantityKg: 1,
              balanceAfterKg: 5,
              date: "2026-01-01",
              reference: "INV-1",
              referenceType: "invoice",
              referenceId: "i",
              cancelled: false,
            },
          ],
        }}
        role="admin"
        error={null}
        notice={null}
        onAdjust={async () => undefined}
        onOpenReference={noop}
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
    "sale form",
    () =>
      withQuery(
        <SaleFormView
          draft={{
            ...emptyDraft(),
            party: { id: "p", name: "ع" },
            lines: [
              {
                key: "k",
                fabricId: "f",
                fabricName: "ق",
                colorId: "c",
                colorName: "ل",
                rollId: "r",
                rollNo: "R1",
                rollCurrency: "USD",
                remainingKg: 5,
                quantityKg: 1,
                pieces: 0,
                pricePerKg: 2,
                discountAmount: 0,
              },
            ],
          }}
          error={null}
          onParty={noop}
          onCurrency={noop}
          onRate={noop}
          onAddLot={noop}
          onEditLine={noop}
          onRemoveLine={noop}
          onPatch={noop}
          onDiscard={noop}
          onSave={async () => undefined}
        />,
      ),
  ],
  [
    "entry form",
    () =>
      withQuery(
        <EntryFormView
          draft={{
            ...emptyEntryDraft(),
            supplier: { id: "s", name: "م" },
            lines: [
              {
                key: "k",
                fabricName: "ق",
                colorName: "ل",
                quantityKg: 1,
                pieces: 1,
                pricePerKg: 2,
              },
            ],
          }}
          error={null}
          onSupplier={noop}
          onCurrency={noop}
          onRate={noop}
          onAddLine={noop}
          onRemoveLine={noop}
          onPatch={noop}
          onDiscard={noop}
          onSave={async () => undefined}
        />,
      ),
  ],
  [
    "voucher form",
    () => (
      <VoucherForm
        kind="receipt"
        values={{ ...emptyVoucher(), party: { id: "p", name: "ع" } }}
        balances={[]}
        error={null}
        attempted={false}
        onChange={noop}
        onSave={async () => undefined}
      />
    ),
  ],
  [
    "document done",
    () => (
      <DocumentDoneView title="فاتورة" number="INV-1" onOpen={noop} onNew={noop} newLabel="جديدة" />
    ),
  ],
  [
    "login",
    () => (
      <LoginView
        users={[{ id: "u1", name: "أ", role: "admin", hasPin: false }]}
        selectedId={null}
        pin=""
        pinStep="enter"
        error={null}
        busy={false}
        mode="pin"
        email=""
        password=""
        onSelect={noop}
        onKey={noop}
        onToggleMode={noop}
        onChangeCredentials={noop}
        onSubmit={noop}
      />
    ),
  ],
  [
    "party list",
    () => (
      <PartyListView
        rows={[
          {
            id: "p",
            name: "ع",
            kind: "customer",
            code: "C1",
            phone: null,
            city: null,
            currency: "USD",
          },
        ]}
        balances={{
          p: [{ currency: "USD", balance: 5, side: "debit", totalDebit: 5, totalCredit: 0 }],
        }}
        q=""
        kind=""
        role="admin"
        loading={false}
        error={null}
        refreshing={false}
        onQuery={noop}
        onKind={noop}
        onOpen={noop}
        onNew={noop}
        onRefresh={noop}
        onRetry={noop}
      />
    ),
  ],
  [
    "party detail",
    () => (
      <PartyDetailView
        party={{
          id: "p",
          version: 1,
          name: "ع",
          kind: "customer",
          code: "C1",
          companyName: null,
          phones: ["0933"],
          email: null,
          city: null,
          address: null,
          currency: "USD",
          creditLimit: null,
          notes: null,
          balances: [{ currency: "USD", balance: 5, side: "debit", totalDebit: 5, totalCredit: 0 }],
        }}
        role="admin"
        tab="invoices"
        docs={[
          {
            id: "i",
            kind: "invoice",
            title: "فاتورة بيع",
            number: "INV-1",
            date: "2026-01-01",
            amount: 5,
            currency: "USD",
            note: null,
            cancelled: false,
          },
        ]}
        onTab={noop}
        onStatement={noop}
        onEdit={noop}
        onOpenDoc={noop}
        onNewInvoice={noop}
        onNewVoucher={noop}
      />
    ),
  ],
  [
    "party form with opening balance",
    () => (
      <PartyFormView
        title="عميل جديد"
        values={emptyPartyForm()}
        showOpening
        error={null}
        onChange={noop}
        onSave={async () => undefined}
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
