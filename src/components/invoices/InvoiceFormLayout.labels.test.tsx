/**
 * CODEBASE_AUDIT_REPORT_hermes F-011 — HeaderField / CardField (invoice header and line cards) tie
 * their label to the control, like FormField: <label for> = the control's id.
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import {
  HeaderField,
  CardField,
  FormattedAmountInput,
  PaymentMethodSelect,
} from "./InvoiceFormLayout";
import { Input } from "@/components/ui/input";

const forOf = (html: string) => /<label[^>]*\sfor="([^"]+)"/.exec(html)?.[1];
const idsOf = (html: string) =>
  [...html.matchAll(/<(?:input|textarea|button)[^>]*\sid="([^"]+)"/g)].map((m) => m[1]);

describe("invoice form field labels", () => {
  it("HeaderField wires a plain Input", () => {
    const html = renderToString(
      <HeaderField label="التاريخ">
        <Input type="date" />
      </HeaderField>,
    );
    expect(forOf(html)).toBeTruthy();
    expect(idsOf(html)).toEqual([forOf(html)]);
  });

  it("HeaderField wires the amount input next to a warning box (exchange-rate field)", () => {
    const html = renderToString(
      <HeaderField label="سعر الصرف">
        <FormattedAmountInput value={12000} onChange={() => {}} />
        <div role="alert">تحذير</div>
      </HeaderField>,
    );
    expect(forOf(html)).toBeTruthy();
    expect(idsOf(html)).toEqual([forOf(html)]);
  });

  it("CardField keeps the required star and wires its control", () => {
    const html = renderToString(
      <CardField label="الكمية (كغ)" required>
        <FormattedAmountInput value={5} onChange={() => {}} />
      </CardField>,
    );
    expect(html).toContain("*");
    expect(idsOf(html)).toEqual([forOf(html)]);
  });

  it("a select passes htmlFor and the id lands on its trigger", () => {
    const html = renderToString(
      <HeaderField label="الدفع" htmlFor="sale-payment">
        <PaymentMethodSelect
          id="sale-payment"
          value="نقدي"
          onChange={() => {}}
          methods={[{ id: "1", name: "نقدي" }]}
        />
      </HeaderField>,
    );
    expect(forOf(html)).toBe("sale-payment");
    expect(idsOf(html)).toContain("sale-payment");
  });
});
