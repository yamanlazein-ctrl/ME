import { describe, expect, it } from "vitest";
import { pickFreshNotifications } from "./useLiveNotificationToasts";

const n = (id: string) => ({ id });

describe("pickFreshNotifications", () => {
  it("first load seeds the seen set without toasting the backlog", () => {
    const r = pickFreshNotifications(null, [n("a"), n("b")]);
    expect(r.toShow).toEqual([]);
    expect([...r.seen]).toEqual(["a", "b"]);
  });

  it("toasts only notifications that arrived since, oldest first", () => {
    const first = pickFreshNotifications(null, [n("a")]);
    // API lists newest first.
    const r = pickFreshNotifications(first.seen, [n("c"), n("b"), n("a")]);
    expect(r.toShow.map((x) => x.id)).toEqual(["b", "c"]);
    expect(r.overflow).toBe(0);
    expect(pickFreshNotifications(r.seen, [n("c"), n("b"), n("a")]).toShow).toEqual([]);
  });

  it("caps a burst and reports the overflow", () => {
    const first = pickFreshNotifications(null, []);
    const burst = Array.from({ length: 8 }, (_, i) => n(`x${8 - i}`)); // x8 newest
    const r = pickFreshNotifications(first.seen, burst);
    expect(r.toShow.map((x) => x.id)).toEqual(["x4", "x5", "x6", "x7", "x8"]);
    expect(r.overflow).toBe(3);
  });
});
