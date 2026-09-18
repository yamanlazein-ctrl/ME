/**
 * Hit login and also dump whether the running server can see the user
 * via a tiny internal fetch to /api/auth/device-roster if available.
 */
const base = "http://127.0.0.1:8080";
const body = {
  email: "firstrun.admin+1789646561009@erp.test",
  password: "admin123",
  tenantId: "d9b59c10-1875-4cfd-8da7-1fea2c4944fd",
};

const r = await fetch(`${base}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify(body),
});
const text = await r.text();
console.log("status", r.status);
console.log("body", text);
console.log("headers", Object.fromEntries(r.headers.entries()));

// Try archived admin too after we reset it
const r2 = await fetch(`${base}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    email: "admin@erp.local",
    password: "admin123",
    tenantId: "407fccfc-ba89-41c5-b5b9-ddb2c4f385d9",
  }),
});
console.log("archived", r2.status, await r2.text());
