import { defineConfig } from "drizzle-kit";

const supabaseUrl = process.env.SUPABASE_URL;

if (!supabaseUrl) {
  throw new Error("SUPABASE_URL environment variable is required");
}

// If using Supabase direct connection string (preferred with pgBouncer or direct Postgres port)
// Expected format from Supabase dashboard: postgresql://postgres:[YOUR-PASSWORD]@db.xxxxxxxxxx.supabase.co:5432/postgres
const connectionString = supabaseUrl;

export default defineConfig({
  schema: "./src/infrastructure/db/schema/*",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: connectionString,
  },
});
