// Import-boundary adapter tables, shared by metro.config.js (the app bundle) and vitest.config.ts (Node tests of
// phone code run against the same adapters). See specs/002-mobile-app/contracts/mobile-ports.md.
const path = require("node:path");

const mobileRoot = __dirname;
const repoRoot = path.resolve(mobileRoot, "..");
const backendSrc = path.join(repoRoot, "backend", "src");
const platformDir = path.join(mobileRoot, "src", "platform");

// Allowed built-ins: bare module name -> phone adapter.
const ADAPTERS = {
  "node:async_hooks": path.join(platformDir, "asyncContext.ts"),
  "node:crypto": path.join(platformDir, "nodeCrypto.ts"),
  "better-sqlite3": path.join(platformDir, "sqlite", "BetterSqliteShim.ts"),
};

// Resolved desktop files that the phone replaces (they use node:path, node:url, pino or dotenv).
const FILE_ADAPTERS = {
  [path.join(backendSrc, "infrastructure", "config", "logger.ts")]: path.join(
    platformDir,
    "logger.ts",
  ),
  [path.join(backendSrc, "infrastructure", "config", "env.ts")]: path.join(
    platformDir,
    "envConfig.ts",
  ),
  // The PostgreSQL pool (pg) and the file-based SQLite boot: unreachable / replaced on the phone.
  [path.join(backendSrc, "infrastructure", "orm", "drizzle.ts")]: path.join(
    platformDir,
    "pgUnavailable.ts",
  ),
  [path.join(backendSrc, "infrastructure", "orm", "sqlite", "runtime.ts")]: path.join(
    platformDir,
    "sqliteRuntimeAdapter.ts",
  ),
};

// Built-ins that exactly ONE desktop file may import, each mapped to a phone adapter (see the files in
// src/platform). Everything else that imports them still fails the bundle.
const hubConfigFile = path.join(backendSrc, "application", "use-cases", "sync", "hubConfig.ts");
const numberBlocksFile = path.join(
  backendSrc,
  "application",
  "use-cases",
  "sync",
  "numberBlockUseCases.ts",
);
const IMPORTER_ADAPTERS = [
  [path.join(backendSrc, "infrastructure", "orm", "sqlite", "types.ts"), "node:net", "netIsIp.ts"],
  [hubConfigFile, "node:fs", "hubFs.ts"],
  [hubConfigFile, "node:path", "hubPath.ts"],
  [hubConfigFile, "node:crypto", "hubCrypto.ts"],
  [numberBlocksFile, "node:os", "osInfo.ts"],
];

// IMPORTER_ADAPTERS rows are [importer file, module name, adapter file name in src/platform].
module.exports = {
  backendSrc,
  platformDir,
  ADAPTERS,
  FILE_ADAPTERS,
  IMPORTER_ADAPTERS: IMPORTER_ADAPTERS.map(([importer, name, file]) => [
    importer,
    name,
    path.join(platformDir, file),
  ]),
};
