// Backend lint surface (M-09). The root eslint.config.js ignores backend/** (it is the frontend's
// gate), so the backend's architecture rule needs its own config to run at all.
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  // TypeScript parser for the boundary rule below. No eslint-disable comments remain in the backend
  // (2026-10-12), so unused-directive reporting stays at ESLint's default.
  {
    files: ["src/**/*.ts"],
    languageOptions: { parser: tseslint.parser },
  },
  // Architecture boundary (Phase F — docs/decisions.md D-006): direct database access is allowed
  // ONLY in the RLS-stamping pool (drizzle.ts). Any other pg import would bypass the
  // app.current_tenant_id / app.platform_mode stamping that makes row-level security correct.
  {
    files: ["src/**/*.ts"],
    ignores: ["src/infrastructure/orm/drizzle.ts"],
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
);
