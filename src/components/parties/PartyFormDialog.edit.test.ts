/**
 * Customers/Suppliers review — the edit dialog's patch.
 *  - a field the operator CLEARS is sent as "" (it used to become undefined, vanish from the JSON and
 *    leave the old phone/email/address in place while the dialog said "saved");
 *  - the version the form was opened with travels as the expected version (the API client otherwise
 *    re-read the current version, so another device's edit was silently overwritten);
 *  - create keeps "blank = not provided".
 */
import { describe, it, expect } from "vitest";
import { fromParty, toPatch, type SimpleParty } from "./partyFormModel";

const party: SimpleParty = {
  id: "p1",
  name: "عميل",
  phone: "0999",
  email: "a@b.co",
  address: "حلب",
  notes: "قديمة",
  currency: "USD",
  version: 7,
};

describe("PartyFormDialog edit patch", () => {
  it("clearing phone / email / address / notes sends empty strings", () => {
    const d = { ...fromParty(party, "customer"), phone: "", email: "  ", address: "", notes: "" };
    const out = toPatch(d, "customer", party);
    expect(out).toMatchObject({ phone: "", email: "", address: "", notes: "" });
  });

  it("carries the version the form was opened with", () => {
    expect(toPatch(fromParty(party, "customer"), "customer", party).version).toBe(7);
  });

  it("create: blank fields stay absent and no version is sent", () => {
    const d = { ...fromParty({ id: "", name: "جديد", currency: "SYP" }, "customer"), phone: "" };
    const out = toPatch(d, "customer", undefined);
    expect(out.phone).toBeUndefined();
    expect(out.version).toBeUndefined();
  });
});
