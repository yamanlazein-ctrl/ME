import pg from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const c = new pg.Client({ connectionString: "postgresql://postgres:postgres@localhost:5432/erp_test" });
await c.connect();

const dir = join(process.cwd(), "src/infrastructure/orm/migrations");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .filter((f) => f >= "0029"); // 0001–0028 already applied successfully

for (const f of files) {
  const raw = readFileSync(join(dir, f), "utf8");
  // Test-DB adaptation: some migrations hardcode the prod DB name.
  const sql = raw.replaceAll("DATABASE fabric_erp", "DATABASE erp_test");
  const stmts = sql.split("--> statement-breakpoint");
  try {
    await c.query("BEGIN");
    for (const s of stmts) {
      const t = s.trim();
      if (!t) continue;
      await c.query(t);
    }
    await c.query("COMMIT");
    console.log("OK ", f);
  } catch (e) {
    await c.query("ROLLBACK");
    console.error("FAIL", f, "->", e.message.split("\n")[0]);
    process.exitCode = 1;
    break;
  }
}

const pb = await c.query(
  "SELECT count(*) AS n FROM information_schema.tables WHERE table_name='party_balances'"
);
console.log("party_balances exists:", pb.rows[0].n > 0 ? "YES" : "NO");
await c.end();
