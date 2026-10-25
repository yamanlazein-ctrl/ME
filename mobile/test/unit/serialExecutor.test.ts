import { describe, expect, it } from "vitest";
import { AsyncLocalStorage } from "../../src/platform/asyncContext";
import { runSerial } from "../../src/core/serialExecutor";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("serial executor", () => {
  it("two jobs started together never interleave", async () => {
    const log: string[] = [];
    const job = (name: string, ms: number) => async () => {
      log.push(`${name}:start`);
      await tick(ms);
      log.push(`${name}:mid`);
      await tick(ms);
      log.push(`${name}:end`);
    };
    await Promise.all([runSerial(job("A", 10)), runSerial(job("B", 1))]);
    expect(log).toEqual(["A:start", "A:mid", "A:end", "B:start", "B:mid", "B:end"]);
  });

  it("a rejected job does not block the next", async () => {
    const failing = runSerial(async () => {
      throw new Error("boom");
    });
    const next = runSerial(async () => "ok");
    await expect(failing).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });

  it("returns each job's own result in order", async () => {
    const results = await Promise.all([1, 2, 3].map((n) => runSerial(async () => n * 2)));
    expect(results).toEqual([2, 4, 6]);
  });
});

describe("AsyncLocalStorage replacement", () => {
  it("nested run returns the innermost store and restores the outer one", async () => {
    const als = new AsyncLocalStorage<string>();
    expect(als.getStore()).toBeUndefined();
    await als.run("outer", async () => {
      expect(als.getStore()).toBe("outer");
      await als.run("inner", async () => {
        await tick(1);
        expect(als.getStore()).toBe("inner");
      });
      expect(als.getStore()).toBe("outer");
    });
    expect(als.getStore()).toBeUndefined();
  });

  it("restores after a throw and supports enterWith", () => {
    const als = new AsyncLocalStorage<number>();
    expect(() =>
      als.run(1, () => {
        throw new Error("x");
      }),
    ).toThrow("x");
    expect(als.getStore()).toBeUndefined();
    als.enterWith(7);
    expect(als.getStore()).toBe(7);
  });

  it("works inside the serial executor", async () => {
    const als = new AsyncLocalStorage<string>();
    const seen: Array<string | undefined> = [];
    await Promise.all(
      ["a", "b"].map((s) =>
        runSerial(() =>
          als.run(s, async () => {
            await tick(2);
            seen.push(als.getStore());
          }),
        ),
      ),
    );
    expect(seen).toEqual(["a", "b"]);
  });
});
