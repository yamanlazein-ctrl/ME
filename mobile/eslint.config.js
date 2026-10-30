// Flat config. The import boundary (constitution V, contracts/mobile-ports.md) mirrors metro.config.js.
const js = require("@eslint/js");
const globals = require("globals");
const tseslint = require("typescript-eslint");

const MESSAGE = "Banned on the phone: see specs/002-mobile-app/contracts/mobile-ports.md";

const bannedNames = [
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

const boundary = {
  paths: bannedNames.map((name) => ({ name, message: MESSAGE })),
  patterns: [
    { group: ["node:fs", "node:path", "node:os", "node:net", "node:url"], message: MESSAGE },
    { group: ["fs/*", "path/*", "os/*", "net/*"], message: MESSAGE },
    { group: ["@sentry/*"], message: MESSAGE },
  ],
};

module.exports = tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "android/**",
      "ios/**",
      ".expo/**",
      "dist/**",
      "src/core/generated/**",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: { ecmaVersion: 2022, globals: { ...globals.es2021 } },
    rules: {
      "no-restricted-imports": ["error", boundary],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    // Node-side tooling and tests may use Node modules; they are never part of the app bundle.
    files: ["test/**", "scripts/**", "*.config.{js,ts}", "metro.config.js"],
    languageOptions: { globals: { ...globals.node } },
    rules: { "no-restricted-imports": "off" },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
