#!/usr/bin/env node
/**
 * A disposable hub for the emulator job (FIX-05): a fresh PostgreSQL clone of the AC-8 template, the unchanged backend
 * on 0.0.0.0, a test licence, a PIN for the admin, generated data pushed through the real sync endpoint
 * (scripts/parity/seed-sync-volume.mjs) and a fresh enrolment code. Writes the connection facts to HUB_INFO and stays
 * alive until killed.
 *
 *   CERT_PG_URL=<admin connection url of a throw-away PostgreSQL> HUB_INFO=hub-info.json node scripts/emulator/start-test-hub.mjs
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ac8 from "../parity/lib/syncAc8.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
const requireBackend = createRequire(join(repo, "backend/package.json"));
const PORT = Number(process.env.HUB_PORT ?? 18080);
const INFO = process.env.HUB_INFO ?? "hub-info.json";
const PIN = process.env.TEST_PIN ?? "1234";
const NO_PIN_USER_ID = "33333333-3333-4333-8333-333333333333";
const admin = process.env.CERT_PG_URL;
if (!admin) throw new Error("CERT_PG_URL is required");

process.env.JWT_SECRET ??= ac8.JWT_HUB;
const work = mkdtempSync(join(tmpdir(), "motard-emulator-hub-"));
const dbName = `erp_emulator_${Date.now()}`;

await ac8.ensurePgTemplate(admin, false);
await ac8.clonePg(admin, dbName);
const dbUrl = ac8.dbUrl(admin, dbName);
await ac8.seedPg(dbUrl, "emulator");

// Licence (enrolment needs one) and the admin's PIN.
const { hash } = requireBackend("@node-rs/argon2");
const pinHash = await hash(PIN, { memoryCost: 65536, timeCost: 3, parallelism: 4, algorithm: 2 });
await ac8.withClient(dbUrl, async (c) => {
  const key = "LIC-EMULATOR-0001";
  await c.query(
    `INSERT INTO licenses (key, type, status, max_devices, tenant_id) VALUES ($1, 'perpetual', 'active', 20, $2)
     ON CONFLICT (key) DO NOTHING`,
    [key, ac8.TENANT_ID],
  );
  await c.query("UPDATE tenants SET license_key = $1, license_status = 'active' WHERE id = $2", [
    key,
    ac8.TENANT_ID,
  ]);
  await c.query("UPDATE users SET pin_hash = $1 WHERE id = $2", [pinHash, ac8.USER_ID]);
  // A second user WITHOUT a PIN, as every real customer's staff starts: the phone must let them choose one.
  await c.query(
    `INSERT INTO users (id, tenant_id, name, email, password_hash, role, active)
     VALUES ($1, $2, $3, $4, $5, 'accountant', true) ON CONFLICT (id) DO NOTHING`,
    [NO_PIN_USER_ID, ac8.TENANT_ID, "ليلى المحاسبة", "leila@example.com", await hash("Leila-pass-2026")],
  );
});

const hub = ac8.startNode(
  "hub",
  ac8.nodeEnv({
    DB_ENGINE: "postgres",
    DATABASE_URL: dbUrl,
    PORT: String(PORT),
    HOST: "0.0.0.0",
    JWT_SECRET: ac8.JWT_HUB,
  }),
  join(work, "hub.log"),
);
process.on("exit", () => hub.kill());
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
await ac8.waitHealthy(PORT, hub);

const token = await ac8.mintToken(ac8.JWT_HUB);
const hubUrl = `http://127.0.0.1:${PORT}`;

// Generated data, pushed as real sync units by an enrolled seed device.
await new Promise((resolve, reject) => {
  const seed = spawn(
    process.execPath,
    [
      join(repo, "scripts/parity/seed-sync-volume.mjs"),
      "--hub",
      hubUrl,
      "--invoices",
      process.env.SEED_INVOICES ?? "60",
      "--parties",
      process.env.SEED_PARTIES ?? "12",
      "--out",
      join(work, "seed.json"),
    ],
    { env: { ...process.env, ADMIN_TOKEN: token }, stdio: "inherit" },
  );
  seed.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`seed exited ${code}`))));
});

// The phone's enrolment code.
const codeRes = await fetch(`${hubUrl}/api/sync/enrollment-code`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ maxUses: 10 }),
});
if (codeRes.status !== 201) throw new Error(`enrollment code failed: ${codeRes.status}`);
const code = (await codeRes.json()).current.code;

const seeded = JSON.parse((await import("node:fs")).readFileSync(join(work, "seed.json"), "utf8"));
writeFileSync(
  INFO,
  JSON.stringify(
    {
      hubForEmulator: `http://10.0.2.2:${PORT}`,
      hubLocal: hubUrl,
      code,
      pin: PIN,
      userName: "AC-8 Admin",
      counts: seeded.counts,
      log: join(work, "hub.log"),
    },
    null,
    2,
  ),
);
console.log("HUB_READY");
await new Promise(() => undefined);
