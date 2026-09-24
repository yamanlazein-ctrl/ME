/**
 * A dropped database connection must not kill the server process.
 *
 * pg emits 'error' on a CHECKED-OUT client whose socket dies between queries.
 * With no listener, EventEmitter throws — an uncaught exception that exited the
 * desktop backend under the load audit ("Connection terminated unexpectedly").
 */
import { describe, it, expect } from "vitest";
import { pool } from "@/infrastructure/orm/drizzle.js";

describe("pool client errors", () => {
  it("an error on a checked-out client is handled, not thrown", async () => {
    const client = await pool.connect();
    try {
      expect(() => client.emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();
    } finally {
      client.release(true);
    }
  });

  it("an idle-client error on the pool is handled, not thrown", () => {
    expect(() => pool.emit("error", new Error("idle client died"), undefined as never)).not.toThrow();
  });
});
