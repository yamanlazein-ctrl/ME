import { defineConfig } from "drizzle-kit";
import dotenv from "dotenv";

// Load .env from project root (shared with frontend) and backend local
dotenv.config({ path: "../.env" });
dotenv.config({ path: ".env" });

export default defineConfig({
  schema: "./src/infrastructure/orm/schemas/*.table.ts",
  out: "./src/infrastructure/orm/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/erp",
  },
  verbose: true,
  strict: true,
});
