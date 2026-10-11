import { describe, it, expect } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { FormField } from "./FormField";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

// A label must name its control (<label for> = control id); otherwise screen readers and
// `getByLabel` see an unnamed textbox — what the e2e run found on the customer and receipt forms.
const forOf = (html: string) => /<label[^>]*\sfor="([^"]+)"/.exec(html)?.[1];
const idsOf = (html: string) =>
  [...html.matchAll(/<(?:input|textarea|button)[^>]*\sid="([^"]+)"/g)].map((m) => m[1]);

describe("FormField label ↔ control", () => {
  it("wires a single Input to its label", () => {
    const html = renderToString(
      <FormField label="اسم العميل *">
        <Input />
      </FormField>,
    );
    const target = forOf(html);
    expect(target).toBeTruthy();
    expect(idsOf(html)).toEqual([target]);
  });

  it("wires a single Textarea to its label", () => {
    const html = renderToString(
      <FormField label="ملاحظات">
        <Textarea />
      </FormField>,
    );
    expect(idsOf(html)).toEqual([forOf(html)]);
  });

  it("keeps a control's own id and points the label at it", () => {
    const html = renderToString(
      <FormField label="الهاتف">
        <Input id="phone" />
      </FormField>,
    );
    expect(forOf(html)).toBe("phone");
    expect(idsOf(html)).toEqual(["phone"]);
  });

  it("uses an explicit htmlFor for a composite control (e.g. a select trigger)", () => {
    const html = renderToString(
      <FormField label="العملة" htmlFor="ccy">
        <button type="button" id="ccy" role="combobox">
          دولار
        </button>
      </FormField>,
    );
    expect(forOf(html)).toBe("ccy");
  });

  it("never gives two controls the same id", () => {
    const html = renderToString(
      <FormField label="سعر الصرف">
        <Input />
        <Input />
      </FormField>,
    );
    const ids = idsOf(html);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
