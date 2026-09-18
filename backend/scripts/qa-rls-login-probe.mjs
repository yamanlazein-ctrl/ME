import "dotenv/config";
import pg from "pg";
import { verify } from "@node-rs/argon2";

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const tenantId = "d9b59c10-1875-4cfd-8da7-1fea2c4944fd";
const email = "firstrun.admin+1789646561009@erp.test";

await c.query("SELECT set_config('app.current_tenant_id', $1, false)", [tenantId]);
await c.query("SELECT set_config('app.platform_mode', $1, false)", ["false"]);
const r = await c.query(
  `SELECT id, email, active, password_hash, pin_hash FROM users WHERE email = $1 AND tenant_id = $2`,
  [email, tenantId],
);
console.log("rows", r.rows.map((x) => ({ id: x.id, email: x.email, active: x.active })));
if (r.rows[0]) {
  console.log("pw", await verify(r.rows[0].password_hash, "admin123"));
  console.log("pin", await verify(r.rows[0].pin_hash, "4829"));
}
await c.end();
