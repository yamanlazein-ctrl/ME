import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist",
      ".output",
      ".vinxi",
      // Playwright / packaging / backend scripts are not the app lint surface.
      "tests/**",
      "backend/**",
      "desktop/**",
      "admin-dashboard/**",
      "packages/**",
      "scripts/**",
      "tools/**",
      "vitest.config.ts",
      ".tmp-pgdata-dev/**",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "warn",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  // Architecture boundary: routes/components must go through presentation hooks,
  // not through @/lib/mock-* directly. Promoted to ERROR (T10 complete).
  {
    files: ["src/routes/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/mock-*"],
              message:
                "لا تستورد من @/lib/mock-* مباشرة داخل routes/components. استخدم hooks من src/presentation/hooks (طبقة Repository).",
            },
          ],
        },
      ],
    },
  },
  // Architecture boundary (Phase F — docs/decisions.md D-006): direct
  // database access is allowed ONLY in the RLS-stamping pool
  // (backend drizzle.ts). Any other pg import would bypass the
  // app.current_tenant_id / app.platform_mode stamping that makes
  // row-level security correct in a shared pool.
  {
    files: ["backend/src/**/*.ts"],
    ignores: ["backend/src/infrastructure/orm/drizzle.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "pg",
              message:
                "لا تصل إلى قاعدة البيانات مباشرة عبر pg خارج src/infrastructure/orm/drizzle.ts — استخدم db/withTenantTx حتى لا يتجاوز الوصول إلى RLS (سياق المستأجر يُختم في TenantScopedPool).",
            },
          ],
        },
      ],
    },
  },
  // shadcn/ui components commonly export both components and utilities;
  // suppress react-refresh fast-refresh warnings for the ui directory.
  {
    files: ["src/components/ui/**/*.{ts,tsx}"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
  // InlineFabricCell and theme-provider export helper functions alongside
  // their components as part of their module design — suppress react-refresh.
  {
    files: ["src/components/invoices/InlineFabricCell.tsx", "src/components/theme-provider.tsx"],
    rules: {
      "react-refresh/only-export-components": "off",
    },
  },
  eslintPluginPrettier,
);
