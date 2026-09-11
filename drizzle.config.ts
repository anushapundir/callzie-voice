import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: ".env.local" });

// Migrations and `drizzle-kit studio` both run from your machine, so they reach
// Cloud SQL through the Auth Proxy on 127.0.0.1 — not the unix socket that
// Cloud Run uses. See docs/adr/0001-gcp-deploy-target.md.
export default defineConfig({
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});
