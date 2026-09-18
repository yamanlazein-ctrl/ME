import "dotenv/config";
import pg from "pg";
import { verify, hash } from "@node-rs/argon2";

const app = new URL(process.env.DATABASE_URL);
const c = new pg.Client({
  connectionString: `postgresql://postgres:postgres@${app.hostname}:${app.port || 5432}/erp`,
});
await c.connect();
const USER_ID = "3cc49d25-9614-40f0-a61d-9f8aacc14e0d";
const u = await c.query("SELECT password_hash, pin_hash, active, email FROM users WHERE id = $1", [
  USER_ID,
]);
const row = u.rows[0];
console.log("email", row.email, "active", row.active);
console.log("pw_ok", await verify(row.password_hash, "admin123"));
console.log("pin_ok", await verify(row.pin_hash, "4829"));

const opts = { memoryCost: 65536, timeCost: 3, parallelism: 4, algorithm: 2 };
const pwHash = await hash("admin123", opts);
const pinHash = await hash("4829", opts);
await c.query(
  "UPDATE users SET password_hash = $1, pin_hash = $2, active = true, updated_at = now() WHERE id = $3",
  [pwHash, pinHash, USER_ID],
);
console.log("rewritten with app params");
await c.end();

const r = await fetch("http://127.0.0.1:8080/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email: "firstrun.admin+1789646561009@erp.test",
    password: "admin123",
    tenantId: "d9b59c10-1875-4cfd-8da7-1fea2c4944fd",
  }),
});
const j = await r.json();
console.log("login", r.status, j.code || j.user?.name, !!j.accessToken);

const r2 = await fetch("http://127.0.0.1:8080/api/auth/pin-login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    userId: USER_ID,
    pin: "4829",
    tenantId: "d9b59c10-1875-4cfd-8da7-1fea2c4944fd",
  }),
});
const j2 = await r2.json();
console.log("pin", r2.status, j2.code || j2.user?.name, !!j2.accessToken);
if (j2.message) console.log("pin_msg", j2.message);
if (j.message) console.log("login_msg", j.message);
