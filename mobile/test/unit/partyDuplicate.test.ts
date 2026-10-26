import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestPhone, type TestPhone } from "../helpers/testPhone";

describe("duplicate party name", () => {
  let t: TestPhone;
  beforeAll(async () => {
    t = await makeTestPhone();
  });
  afterAll(() => t?.close());

  it("the second party with the same name is refused with the friendly text", async () => {
    const first = await t.phone.documents.createParty("customer", { name: "Zed 1", phone: "055" });
    expect(first.ok).toBe(true);
    const second = await t.phone.documents.createParty("customer", { name: "Zed 1" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("اسم العميل/المورد مستخدم مسبقاً");
  });
});
