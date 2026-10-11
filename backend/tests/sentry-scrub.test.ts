import { describe, it, expect } from "vitest";
import { scrubSentryEvent } from "@/infrastructure/config/sentryScrub";

describe("scrubSentryEvent (Sentry beforeSend privacy filter)", () => {
  it("drops credentials, cookies, bodies, query strings and user info; keeps the rest", () => {
    const out = scrubSentryEvent({
      message: "boom",
      request: {
        url: "https://hub.example/api/invoices",
        method: "POST",
        headers: { Authorization: "Bearer eyJ.secret", Cookie: "sid=1", "x-setup-token": "t", "user-agent": "UA" },
        cookies: { sid: "1" },
        data: { partyName: "Customer", amount: 100 },
        query_string: "search=Customer",
      },
      user: { id: "u-1", email: "a@b.c", ip_address: "10.0.0.1" },
    });
    expect(out.request?.headers).toEqual({ "user-agent": "UA" });
    expect(out.request).not.toHaveProperty("cookies");
    expect(out.request).not.toHaveProperty("data");
    expect(out.request).not.toHaveProperty("query_string");
    expect(out).not.toHaveProperty("user");
    expect(out.request).toMatchObject({ url: "https://hub.example/api/invoices", method: "POST" });
    expect(out).toMatchObject({ message: "boom" });
  });

  it("leaves an event without request data alone", () => {
    expect(scrubSentryEvent({ message: "x" })).toEqual({ message: "x" });
  });
});
