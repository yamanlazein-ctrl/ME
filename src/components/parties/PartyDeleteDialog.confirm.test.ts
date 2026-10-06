import { describe, expect, it } from "vitest";
import { isPartyDeleteConfirmed, PARTY_DELETE_CONFIRM_PHRASE } from "./PartyDeleteDialog";

describe("party delete confirmation phrase", () => {
  it("is «نعم، متأكد»", () => {
    expect(PARTY_DELETE_CONFIRM_PHRASE).toBe("نعم، متأكد");
  });

  it("accepts the phrase, with either comma and stray spaces", () => {
    expect(isPartyDeleteConfirmed("نعم، متأكد")).toBe(true);
    expect(isPartyDeleteConfirmed("  نعم,  متأكد ")).toBe(true);
  });

  it("refuses anything else, so a click alone can never delete", () => {
    for (const typed of ["", "نعم", "متأكد", "نعم متأكد", "yes", "نعم، متاكد"]) {
      expect(isPartyDeleteConfirmed(typed)).toBe(false);
    }
  });
});
