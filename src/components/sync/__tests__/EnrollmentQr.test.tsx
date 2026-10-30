import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EnrollmentQr } from "../EnrollmentQr";
import { enrollmentQrPayload } from "../enrollmentQrPayload";

describe("enrolment QR (BC-4)", () => {
  it("encodes exactly { hub, code } as JSON", () => {
    expect(JSON.parse(enrollmentQrPayload("https://hub.example", "ABCD-1234"))).toEqual({
      hub: "https://hub.example",
      code: "ABCD-1234",
    });
  });

  it("renders an SVG QR with the scan hint", () => {
    const html = renderToStaticMarkup(<EnrollmentQr hub="https://hub.example" code="ABCD-1234" />);
    expect(html).toContain("<svg");
    expect(html).toContain("امسحه من تطبيق الهاتف");
  });
});
