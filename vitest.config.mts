import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/*
  Tests run against a real Postgres started by vitest.globalSetup.ts on this
  machine — no network, no Cloud SQL, no proxy. The invariants worth testing here
  (a unique clerk_id, the appointments_no_overlap EXCLUDE constraint) live in the
  schema rather than in TypeScript, so a mocked db would only ever test the mock.
  Every test cleans up the rows it writes.
*/
export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./vitest.globalSetup.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // The DB tests share one Postgres; keep files serial so one file's cleanup
    // cannot delete another's fixtures. book.test.ts also drops and restores a
    // constraint, which no other file may observe.
    fileParallelism: false,
    /*
      Back to a normal number. These are still integration tests, but the
      database is now local: a round trip is sub-millisecond rather than the tens
      of milliseconds a Cloud SQL hop cost, so a test that seeds a whole Business
      no longer runs for seconds before it starts asserting.

      Still above Vitest's 5s default, because seeding a Business writes its
      Business Hours, Services and Appointments in one transaction, and because
      the concurrency test in lib/availability/book.test.ts deliberately makes
      three writes contend on the same gist index — the kind of index Postgres
      uses to compare ranges rather than single values, and the one the
      appointments_no_overlap constraint is built on. Contending writes wait for
      each other there instead of running at once.
    */
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
});
