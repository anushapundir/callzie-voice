import { config } from "dotenv";

/*
  Next loads .env.local itself; Vitest does not. Wanted for everything that is
  not the database — Clerk keys, feature flags, INTERNAL_SECRET.

  `override: false` is the default and matters here: vitest.globalSetup.ts has
  already set DATABASE_URL to the local test cluster, and a stale Cloud SQL URL
  in .env.local must not replace it. Pointing the suite at production is exactly
  the accident this arrangement prevents.
*/
config({ path: ".env.local", override: false });

/*
  DATABASE_URL is deliberately not checked here any more. globalSetup provides
  it, so if it is missing the fault is in globalSetup and its own error is
  clearer than anything this file could say.
*/
