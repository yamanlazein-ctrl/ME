// Metro config for the phone app. The phone bundles desktop code in place from ../backend/src and
// ../packages/shared/src (research R1). Every Node-only dependency that code reaches is replaced here by
// exactly one phone adapter, or fails the bundle (contracts/mobile-ports.md).
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const mobileRoot = __dirname;
const repoRoot = path.resolve(mobileRoot, "..");
const backendSrc = path.join(repoRoot, "backend", "src");
const sharedSrc = path.join(repoRoot, "packages", "shared", "src");
const webSrc = path.join(repoRoot, "src");

const { ADAPTERS, FILE_ADAPTERS, IMPORTER_ADAPTERS } = require("./adapters.config.js");

const BANNED = [
  "node:fs",
  "node:path",
  "node:os",
  "node:net",
  "node:url",
  "fs",
  "path",
  "os",
  "net",
  "child_process",
  "http",
  "https",
  "express",
  "pg",
  "argon2",
  "googleapis",
  "pino",
];

function isBanned(name) {
  return (
    BANNED.includes(name) ||
    BANNED.some((b) => !b.startsWith("node:") && name.startsWith(`${b}/`)) ||
    name.startsWith("@sentry/")
  );
}

const config = getDefaultConfig(mobileRoot);

config.watchFolders = [...(config.watchFolders ?? []), backendSrc, sharedSrc, webSrc];

// Desktop files find their packages by walking up (backend/node_modules, root node_modules); the phone's
// own node_modules is the fallback for anything only the phone lists.
config.resolver.nodeModulesPaths = [path.join(mobileRoot, "node_modules")];
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  "@erp/shared": sharedSrc,
  "@backend": backendSrc,
  "@web": webSrc,
};

const defaultResolve = config.resolver.resolveRequest;

function resolveWithJsFallback(context, moduleName, platform) {
  const next = defaultResolve ?? context.resolveRequest;
  try {
    return next(context, moduleName, platform);
  } catch (error) {
    // The desktop code imports TypeScript files with a ".js" suffix (ESM style); Metro needs the bare name.
    if (/^(\.{1,2}\/|\/).*\.(js|jsx)$/.test(moduleName)) {
      return next(context, moduleName.replace(/\.(js|jsx)$/, ""), platform);
    }
    throw error;
  }
}

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith("@backend/")) {
    moduleName = path.join(backendSrc, moduleName.slice("@backend/".length));
  } else if (moduleName.startsWith("@web/")) {
    moduleName = path.join(webSrc, moduleName.slice("@web/".length));
  }
  for (const [importer, name, file] of IMPORTER_ADAPTERS) {
    if (moduleName === name && context.originModulePath === importer) {
      return { type: "sourceFile", filePath: file };
    }
  }
  const adapter = ADAPTERS[moduleName];
  if (adapter) return { type: "sourceFile", filePath: adapter };
  if (isBanned(moduleName)) throw new Error(`mobile import boundary: ${moduleName}`);
  const resolved = resolveWithJsFallback(context, moduleName, platform);
  if (resolved && resolved.type === "sourceFile") {
    const replacement = FILE_ADAPTERS[resolved.filePath];
    if (replacement) return { type: "sourceFile", filePath: replacement };
  }
  return resolved;
};

module.exports = config;
