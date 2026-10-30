// Replaces backend/src/infrastructure/config/env.ts on the phone (Metro file mapping). That file parses
// process.env with zod and needs dotenv. This one is a plain object with the phone's values; `src/core/config.ts`
// fills the enrolment-dependent fields. Every field the bundled desktop code reads is listed in
// specs/002-mobile-app/evidence/T045-ports.md.
export interface PhoneEnvConfig {
  NODE_ENV: "production";
  DB_ENGINE: "sqlite";
  DESKTOP_DEPLOY: boolean;
  NUMBER_BLOCKS_ENABLED: boolean;
  CENTRAL_SYNC_URL: string | undefined;
  APP_MASTER_KEY: string;
  LOG_LEVEL: "info";
  MOTARD_INSTALLATION_ID: string | undefined;
  SQLITE_PATH: string | undefined;
  DATABASE_URL: string;
}

// Desktop SQLite defaults (env.ts): DB_ENGINE sqlite; the phone is a sync device like a desktop install, so
// DESKTOP_DEPLOY is true (never the numbering authority) and number blocks are in use as soon as a hub is set.
export const config: PhoneEnvConfig = {
  NODE_ENV: "production",
  DB_ENGINE: "sqlite",
  DESKTOP_DEPLOY: true,
  NUMBER_BLOCKS_ENABLED: true,
  CENTRAL_SYNC_URL: undefined,
  // Not a secret: only keys the (device-local) hub credential blob; the blob itself sits in Keystore-backed storage.
  APP_MASTER_KEY: "phone-local-credential-blob-key-0000000000000000",
  LOG_LEVEL: "info",
  MOTARD_INSTALLATION_ID: undefined,
  SQLITE_PATH: undefined,
  DATABASE_URL: "",
};

export function applyPhoneConfig(values: Partial<PhoneEnvConfig>): void {
  Object.assign(config, values);
}

export const corsOrigins: string[] | "*" = [];
