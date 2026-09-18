/**
 * License Server entrypoint (Phase 0 sub-batch 0J — full impl).
 *
 * Boots a smaller Express app that hosts the License Server endpoints
 * (`/v1/licenses`, `/v1/activations`, `/v1/activations/:id/heartbeat`,
 * `/v1/activations/:id/devices`, `/v1/activations/:id/devices/:deviceId/revoke`)
 * and the admin API (`/license-admin/*`).
 *
 * Activated by:
 *   LICENSE_SERVER_MODE=server npm run license-server
 *
 * Differences from the customer install:
 *  - No /api/setup/* routes.
 *  - No customer business routes.
 *  - The license private signing key is REQUIRED (env LICENSE_SIGNING_KEY).
 *  - A separate auth realm (admin token) for /license-admin/*.
 */
import express from "express";
import helmet from "helmet";
import cors from "cors";
import { config, corsOrigins } from "../infrastructure/config/env.js";
import { resolveLicenseListenHost } from "../infrastructure/config/licenseListenHost.js";
import { logger } from "../infrastructure/config/logger.js";
import { db } from "../infrastructure/orm/drizzle.js";
import { runWithPlatformContext } from "../infrastructure/orm/tenant-context.js";
import { JwtSigner } from "../infrastructure/auth/JwtSigner.js";
import { PostgresLicenseRepository } from "../infrastructure/repositories/PostgresLicenseRepository.js";
import { PostgresAuditRepository } from "../infrastructure/repositories/PostgresAuditRepository.js";
import { PostgresSystemAdminRepository } from "../infrastructure/repositories/PostgresSystemAdminRepository.js";
import { Argon2PasswordHasher } from "../infrastructure/auth/PasswordHasher.js";
import { DbTokenDenylist, RedisTokenDenylist, CompositeTokenDenylist, redis } from "../infrastructure/auth/TokenDenylist.js";
import { SelfHostedLicenseProvider } from "../infrastructure/license/SelfHostedLicenseProvider.js";
import { LicenseTokenSigner } from "../infrastructure/auth/LicenseTokenSigner.js";
import { AesGcmSecretStore, decodeMasterKey } from "../infrastructure/secrets/AesGcmSecretStore.js";
import { PostgresSecretsRepository } from "../infrastructure/repositories/PostgresSecretsRepository.js";
import type { ISecretsRepository } from "../application/ports/ISecretsRepository.js";
import { randomBytes, generateKeyPairSync, createPublicKey } from "node:crypto";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { JWK } from "jose";
import { createSuperAdminAuthMiddleware } from "../infrastructure/http/middleware/super-admin-auth.middleware.js";
import { createErrorHandler } from "../infrastructure/http/middleware/error-handler.middleware.js";
import { registerLicenseAdminRoutes } from "./license-admin.route.js";
import { registerLicenseV1Routes } from "./license-v1.route.js";

const LICENSE_SERVER_PORT = Number(process.env.LICENSE_SERVER_PORT ?? 8081);
const LICENSE_ADMIN_TOKEN = process.env.LICENSE_ADMIN_TOKEN ?? randomBytes(32).toString("hex");

function buildLicenseTokenSignerForServer(): LicenseTokenSigner {
  if (config.LICENSE_SIGNING_KEY?.trim()) {
    // PEM form. Sign + verify both work. The public key is optional — it is
    // derived from the private key when `LICENSE_SIGNING_PUBLIC_KEY` is unset.
    return LicenseTokenSigner.fromPems(
      config.LICENSE_SIGNING_KEY,
      config.LICENSE_SIGNING_PUBLIC_KEY ?? "",
    );
  }
  // ── Auto-persist for dev/test (same logic as container.ts) ──
  // Production refuses to boot without the key (see env.ts). In dev,
  // generate a persistent keypair and append it to .env so subsequent
  // restarts reuse the same key.
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString().trim();
  const pubPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString().trim();
  const oneLine = (pem: string) => pem.replace(/\n/g, "\\n");

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const envPath = join(__dirname, "..", "..", ".env");
  const envBlock = [
    "",
    "# ── License signing keypair (Ed25519) — auto-generated once, DO NOT regenerate ──",
    "# Rotating these invalidates every offline license token already issued.",
    `LICENSE_SIGNING_KEY="${oneLine(privPem)}"`,
    `LICENSE_SIGNING_PUBLIC_KEY="${oneLine(pubPem)}"`,
    "",
  ].join("\n");

  try {
    if (!existsSync(envPath) || !/^\s*LICENSE_SIGNING_KEY\s*=/m.test(readFileSync(envPath, "utf8"))) {
      appendFileSync(envPath, envBlock, "utf8");
      logger.info(
        { envPath },
        "LICENSE_SIGNING_KEY not set — generated a persistent Ed25519 keypair and appended to .env.",
      );
    }
  } catch (err) {
    logger.warn({ err, envPath }, "Failed to persist LICENSE_SIGNING_KEY to .env — using in-memory key only");
  }

  process.env.LICENSE_SIGNING_KEY = privPem.replace(/\n/g, "\\n");
  process.env.LICENSE_SIGNING_PUBLIC_KEY = pubPem.replace(/\n/g, "\\n");

  const privJwk = privateKey.export({ format: "jwk" }) as JWK;
  const pubJwk = publicKey.export({ format: "jwk" }) as JWK;
  return new LicenseTokenSigner(privJwk, pubJwk);
}

async function main(): Promise<void> {
  if (config.LICENSE_SERVER_MODE !== "server") {
    logger.fatal(
      { mode: config.LICENSE_SERVER_MODE },
      "license-server entrypoint started but LICENSE_SERVER_MODE != 'server' — refusing to boot",
    );
    process.exit(1);
  }

  const licenseRepo = new PostgresLicenseRepository(db);
  const auditRepo = new PostgresAuditRepository(db);
  const jwtSigner = new JwtSigner();
  const tokenSigner = buildLicenseTokenSignerForServer();
  const licenseProvider = new SelfHostedLicenseProvider(tokenSigner, db);

  // Super Admin (Phase 4): credential-based auth backed by `system_admins`.
  const systemAdminRepo = new PostgresSystemAdminRepository(db);
  const passwordHasher = new Argon2PasswordHasher();
  const tokenDenylist = new CompositeTokenDenylist(
    new DbTokenDenylist(),
    redis ? new RedisTokenDenylist(redis) : null,
  );

  // When License Server shares APP_MASTER_KEY + Postgres with the ERP install,
  // refresh can rewrite secrets.license.token.* after Vendor PATCH/suspend.
  let secretsRepo: ISecretsRepository | undefined;
  let secretCipher: AesGcmSecretStore | undefined;
  const masterKey = decodeMasterKey(config.APP_MASTER_KEY);
  if (masterKey) {
    secretCipher = new AesGcmSecretStore(masterKey);
    secretsRepo = new PostgresSecretsRepository(secretCipher, db);
  } else {
    logger.warn(
      "APP_MASTER_KEY unset on License Server — entitlement refresh will update licenses.offline_token only",
    );
  }

  // First-boot seeding: create the Super Admin from env if none exists.
  if (config.SUPER_ADMIN_EMAIL && config.SUPER_ADMIN_PASSWORD) {
    try {
      if ((await systemAdminRepo.count()) === 0) {
        const hash = await passwordHasher.hash(config.SUPER_ADMIN_PASSWORD);
        await systemAdminRepo.create({
          email: config.SUPER_ADMIN_EMAIL,
          passwordHash: hash,
          name: "Super Admin",
          role: "super_admin",
        });
        logger.info({ email: config.SUPER_ADMIN_EMAIL }, "Seeded initial Super Admin");
      }
    } catch (err) {
      logger.error({ err }, "Failed to seed Super Admin");
    }
  }

  const app = express();
  app.use(helmet());
  app.use(cors({ origin: corsOrigins, credentials: true }));
  app.use(express.json({ limit: "1mb" }));

  // Every license-server request is a platform request: it manages licenses,
  // activations, devices and audit events across ALL tenants and touches
  // system-owned (NULL-tenant) rows. Establish the platform RLS context for
  // the whole request so the category-2/3 policies grant visibility.
  app.use((_req, _res, next) => {
    runWithPlatformContext(() => next());
  });

  // Public v1 endpoints (called by the customer install).
  registerLicenseV1Routes(app, { licenseRepo, auditRepo, licenseProvider, tokenSigner });

  // Admin API (Super Admin JWT, with LICENSE_ADMIN_TOKEN fallback).
  // Local owner console (admin-dashboard on loopback) skips login — must match
  // App.tsx `isLoopbackHost()`. Opt out with LICENSE_ADMIN_OPEN_LOOPBACK=0.
  // Production stays closed unless explicitly set to "1".
  const openLoopbackEnv = process.env.LICENSE_ADMIN_OPEN_LOOPBACK;
  const openLoopback =
    openLoopbackEnv === "1" ||
    (openLoopbackEnv !== "0" && process.env.NODE_ENV !== "production");

  // DFP-030: open loopback privilege must never be reachable on a LAN/WAN bind.
  const requestedHost = (process.env.HOST ?? process.env.LICENSE_SERVER_HOST ?? "0.0.0.0").trim();
  const { listenHost } = resolveLicenseListenHost(openLoopback, requestedHost);

  const adminAuth = createSuperAdminAuthMiddleware(jwtSigner, tokenDenylist, {
    fallbackToken: LICENSE_ADMIN_TOKEN,
    openLoopback,
  });
  registerLicenseAdminRoutes(app, {
    licenseRepo,
    auditRepo,
    jwtSigner,
    adminAuth,
    systemAdminRepo,
    passwordHasher,
    tokenDenylist,
    licenseTokenSigner: tokenSigner,
    secretsRepo,
    secretCipher,
    db,
  });

  // Fix (Phase 1 audit, F13 cluster): this app never registered an error
  // handler, so any thrown/next(err)'d error — including a plain empty-table
  // query — fell through to Express's default handler and returned an HTML
  // error page instead of JSON. That's what made "license server lists
  // licenses" health checks read as `count=undefined`: the caller was
  // parsing an HTML error page as `{licenses:[...]}`. Must be registered
  // last, after all routes.
  app.use(createErrorHandler(logger));

  app.listen(LICENSE_SERVER_PORT, listenHost, () => {
    logger.info(
      {
        port: LICENSE_SERVER_PORT,
        host: listenHost,
        adminTokenSet: !!process.env.LICENSE_ADMIN_TOKEN,
        openLoopback,
      },
      "License Server listening",
    );
    if (!process.env.LICENSE_ADMIN_TOKEN) {
      logger.warn(
        { ephemeralAdminToken: LICENSE_ADMIN_TOKEN },
        "LICENSE_ADMIN_TOKEN not set; ephemeral token generated for this boot (sessions will not survive restarts)",
      );
    }
  });
}

main();
