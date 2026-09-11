# Availability Engine and the No-Overlap Constraint — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Given a Business and a Service, return the open Slots — and prove with tests that the database, not the application, is what stops two Calls booking the same Slot.

**Architecture:** A pure function does the Slot arithmetic with no database, so the daylight-saving cases can be tested instantly. A thin database layer feeds it. A separate booking function turns the database's constraint rejection into an ordinary return value. The whole suite moves onto a Postgres that runs on the developer's machine, which is what makes the suite network-free and makes dropping the constraint safe.

**Tech Stack:** TypeScript, Vitest, Drizzle ORM, Postgres 16 (`embedded-postgres` locally, Cloud SQL in production), `lib/time/zone.ts` for timezone arithmetic.

**Design doc:** `docs/superpowers/specs/2026-08-17-availability-engine-design.md`

---

## Before you start

This worktree has no `node_modules`. Install first:

```bash
npm install
```

**Read these before writing code:**

- `docs/superpowers/specs/2026-08-17-availability-engine-design.md` — the design and the reasoning behind each choice.
- `docs/adr/0007-wall-clock-to-instant-without-a-timezone-library.md` — the daylight-saving rules this engine depends on.
- `lib/time/zone.ts` — every timezone helper you need already exists here. Do not add a date library.
- `drizzle/0001_appointments_no_overlap.sql` — the database constraint this whole ticket is about.

**Vocabulary.** Use the words in `CONTEXT.md`: **Slot**, **Availability**, **Appointment**, **Business Hours**, **Service**. Not "booking", "opening", "free time", or "schedule".

**Two terms you will need:**

- **EXCLUDE constraint** — a Postgres rule that refuses to store two rows whose time ranges overlap. It is enforced inside the database, so two requests arriving at the same instant cannot both win.
- **`globalSetup`** — a Vitest file that runs once before any test, and once after all of them. This is where the test database gets started and stopped.

---

## File Structure

| File | Responsibility |
|---|---|
| `vitest.globalSetup.ts` | **New.** Start local Postgres, rebuild the test database, point `DATABASE_URL` at it, stop it at the end. |
| `vitest.config.mts` | **Modify.** Register `globalSetup`; lower the timeouts and rewrite the comment that justified them. |
| `vitest.setup.ts` | **Modify.** Stop demanding `DATABASE_URL` from the developer. |
| `.gitignore` | **Modify.** Ignore the local cluster's data directory. |
| `lib/db/schema.ts` | **Modify.** Export the one list of statuses that hold a Slot. |
| `lib/db/schema.test.ts` | **New.** Prove that list still matches the migration. |
| `lib/availability/slots.ts` | **New.** Pure Slot arithmetic. No database, no clock. |
| `lib/availability/slots.test.ts` | **New.** Business Hours, past Slots, busy periods, daylight saving, half-hour offsets. |
| `lib/availability/find.ts` | **New.** Load hours, duration and Appointments; call `slots.ts`. |
| `lib/availability/find.test.ts` | **New.** Which Appointment statuses free a Slot. |
| `lib/availability/book.ts` | **New.** Insert the Appointment; turn a constraint rejection into `slot_taken`. |
| `lib/availability/book.test.ts` | **New.** Acceptance criteria 3 and 4. |
| `docs/adr/0010-availability-steps-in-real-time-not-wall-clock.md` | **New.** Record the decisions. |
| `CONTEXT.md` | **Modify.** Delete the stale `PENDING` block at the foot. |

**Task order matters.** Task 1 must come first — every later test needs the local database, and Task 8 is only safe because the database is disposable.

---

## Task 1: A Postgres that runs on this machine

Right now the tests connect to Cloud SQL over the internet. Issue #6 requires the suite to run with no network, and Task 8 needs a database whose constraint can be dropped without touching the one behind your live site.

**Files:**
- Create: `vitest.globalSetup.ts`
- Modify: `vitest.config.mts`, `vitest.setup.ts`, `.gitignore`, `package.json`

- [ ] **Step 1: Install the local Postgres**

Pinned to `16.14` because production runs `POSTGRES_16` (`scripts/setup-infrastructure.sh:353`). Same major version, so behaviour matches.

```bash
npm install --save-dev embedded-postgres@16.14.0-beta.17
```

- [ ] **Step 2: Ignore the cluster's data directory**

Add to `.gitignore`, directly under the `# agent scratch` block:

```gitignore
# local test Postgres cluster (embedded-postgres) — created by vitest.globalSetup.ts
.pgdata/
```

- [ ] **Step 3: Write the globalSetup file**

Create `vitest.globalSetup.ts`:

```ts
import { rm } from "node:fs/promises";

import EmbeddedPostgres from "embedded-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";

/*
  A real Postgres, on this machine, for the whole test run.

  The suite used to talk to Cloud SQL through the Auth Proxy. Three problems with
  that, and this file fixes all three:

    1. Issue #6 requires the suite to run with no network access.
    2. Every query was a round trip to us-central1, which is why the timeouts in
       vitest.config.mts had to be raised to 30s.
    3. It was the same database that backs the live Cloud Run URL. The test in
       lib/availability/book.test.ts DROPS the no-overlap constraint to prove the
       test is sensitive to it — doing that to production would open a window
       where Callzie really can double-book.

  Postgres 16 to match production's --database-version=POSTGRES_16
  (scripts/setup-infrastructure.sh:353), and btree_gist is present in these
  binaries, which is what makes drizzle/0001's EXCLUDE constraint loadable.
*/

// NOT 5432. scripts/setup-infrastructure.sh tells the developer to run the Cloud
// SQL Auth Proxy on 5432, and a collision there would be baffling to debug.
const PORT = 55_432;
const DATA_DIR = "./.pgdata";
const USER = "postgres";
const PASSWORD = "postgres";
const DATABASE = "callzie_test";

const url = (database: string) =>
  `postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${database}`;

let postgres: EmbeddedPostgres;

export async function setup() {
  postgres = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: USER,
    password: PASSWORD,
    port: PORT,
    // Keep the cluster between runs. `initialise` below is the slow part.
    persistent: true,
    // Defaults to console.log, which prints every Postgres server line into the
    // test output and buries the actual failures.
    onLog: () => {},
    onError: () => {},
  });

  /*
    `initialise` runs initdb, which takes several seconds, and it refuses to run
    against a directory that already holds a cluster. So do it only once and
    keep the result — paying it on every `npm test` would undo the speed this
    file exists to buy.
  */
  let started = false;
  try {
    await postgres.start();
    started = true;
  } catch {
    // No cluster there yet (or a half-written one). Build a fresh one.
    await rm(DATA_DIR, { recursive: true, force: true });
    await postgres.initialise();
    await postgres.start();
    started = true;
  }
  if (!started) throw new Error("Could not start the local test Postgres");

  /*
    The cluster survives between runs but the DATABASE does not, and that is a
    correctness requirement rather than tidiness.

    book.test.ts drops `appointments_no_overlap` to prove its concurrency test
    is sensitive to it. If a run dies between the drop and the restore, a reused
    database would still have migration 0001 recorded as applied — so the
    constraint would never come back, and every later run would pass while
    testing a database with no no-overlap guarantee at all.

    Postgres will not drop a database you are connected to, so this is issued
    against the default `postgres` database.
  */
  const admin = new Client({ connectionString: url("postgres") });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
  await admin.query(`CREATE DATABASE ${DATABASE}`);
  await admin.end();

  /*
    Migrate rather than push a schema snapshot. Migration 0001 is hand-written
    (Drizzle cannot express EXCLUDE) and is deliberately absent from the meta
    snapshot, so only the migration path installs the constraint this ticket is
    about. It is listed in drizzle/meta/_journal.json, so `migrate` picks it up.
  */
  const client = new Client({ connectionString: url(DATABASE) });
  await client.connect();
  await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  await client.end();

  /*
    Set here, not in .env.local, and this is what makes the suite safe by
    construction: lib/db/index.ts reads DATABASE_URL lazily at its first query
    rather than at import, so this value is the one every test connects with. A
    developer with a real Cloud SQL URL in .env.local cannot point the suite at
    production by accident.
  */
  process.env.DATABASE_URL = url(DATABASE);
}

export async function teardown() {
  // The data directory stays. Next run reuses the cluster and skips initdb.
  await postgres?.stop();
}
```

- [ ] **Step 4: Register it and bring the timeouts down**

In `vitest.config.mts`, replace the whole `test` block and the file's top comment with this. The old comment explained the 30-second timeouts by describing the Cloud SQL round trip — that reason no longer exists, so it has to go, not just the number.

```ts
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
      three writes contend on the same gist index.
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
```

- [ ] **Step 5: Stop demanding a DATABASE_URL from the developer**

Replace the whole of `vitest.setup.ts` with this.

Note the ordering that makes it work: `globalSetup` runs **once, before**
`setupFiles`, and `setupFiles` then runs once per test file. So by the time this
file executes, `DATABASE_URL` already holds the local cluster's address. It must
not be cleared or overwritten here.

```ts
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
```

- [ ] **Step 6: Run the existing suite and confirm it passes against the local database**

```bash
npm test
```

Expected: every existing test from #4, #5 and #9 passes, with no Cloud SQL Auth Proxy running. First run is slower — that is `initdb` building the cluster once. Run it a second time and it should be noticeably faster.

If a test fails on a missing table, the migration step did not run — check the `migrationsFolder` path.

- [ ] **Step 7: Prove there is no network dependency**

Stop the Cloud SQL Auth Proxy if it is running, then run the suite again. It must still pass. This is acceptance criterion 6.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json vitest.globalSetup.ts vitest.config.mts vitest.setup.ts .gitignore
git commit -m "Run the test suite against a local Postgres, not Cloud SQL

Issue #6 requires the suite to run with no network access, and its
concurrency test needs to drop appointments_no_overlap to prove the test is
sensitive to it — which is not safe against the instance backing the live URL.

embedded-postgres pinned to 16.14 to match production's POSTGRES_16. The
cluster persists in .pgdata so initdb is paid once, but the database is
dropped and re-migrated every run: if a run dies between dropping the
constraint and restoring it, a reused database would keep migration 0001
recorded as applied and the constraint would never come back."
```

---

## Task 2: One list of the statuses that hold a Slot

The constraint ignores `declined` and `cancelled`. The Availability query must ignore exactly the same two. If they ever disagree, Availability offers a Slot the database then refuses — or hides one it would have accepted.

**Files:**
- Modify: `lib/db/schema.ts`
- Create: `lib/db/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/db/schema.test.ts`:

```ts
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  APPOINTMENT_STATUSES,
  SLOT_FREEING_STATUSES,
  SLOT_HOLDING_STATUSES,
} from "@/lib/db/schema";

/*
  No database needed. This guards a very specific way for this feature to break
  silently: someone edits the EXCLUDE constraint's WHERE clause in the migration
  and does not edit the query in lib/availability/find.ts, or the other way
  round. Nothing about that would fail to compile, and Availability would start
  disagreeing with the database about which Slots are free.
*/

const MIGRATION = readFileSync(
  "./drizzle/0001_appointments_no_overlap.sql",
  "utf8",
);

describe("SLOT_FREEING_STATUSES", () => {
  it("lists exactly the statuses the EXCLUDE constraint exempts", () => {
    // Pull the statuses out of `WHERE (status NOT IN ('declined', 'cancelled'))`
    const where = /status NOT IN \(([^)]*)\)/.exec(MIGRATION);
    expect(where, "migration 0001 no longer has a `status NOT IN (...)` clause")
      .not.toBeNull();

    const inMigration = [...where![1].matchAll(/'([a-z_]+)'/g)]
      .map((m) => m[1])
      .sort();

    expect(inMigration).toEqual([...SLOT_FREEING_STATUSES].sort());
  });
});

describe("SLOT_HOLDING_STATUSES", () => {
  it("is every other status", () => {
    expect([...SLOT_HOLDING_STATUSES].sort()).toEqual(
      APPOINTMENT_STATUSES.filter(
        (s) => !SLOT_FREEING_STATUSES.includes(s),
      ).sort(),
    );
  });

  it("holds the Slot for an unreachable Appointment", () => {
    // SPEC.md §14 rule 2: an unanswered phone is not a cancellation.
    expect(SLOT_HOLDING_STATUSES).toContain("unreachable");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run lib/db/schema.test.ts
```

Expected: FAIL — `SLOT_FREEING_STATUSES` is not exported from `@/lib/db/schema`.

- [ ] **Step 3: Add the exports**

In `lib/db/schema.ts`, directly after the `NeedsAttentionReason` type (around line 51), add:

```ts
/*
  Which Appointments free their Slot, and which hold it.

  These two lists must agree with the WHERE clause of the `appointments_no_overlap`
  EXCLUDE constraint in drizzle/0001_appointments_no_overlap.sql. If they drift,
  Availability starts offering Slots the database will refuse, and Maya reads a
  time aloud that then fails to book — SPEC.md §3 rule 7, the most damaging
  failure available to this product.

  `lib/db/schema.test.ts` parses the migration and asserts the lists still match,
  because a constant alone cannot catch someone editing only the SQL.

  Note what is NOT here: `unreachable`. An unanswered phone is not a
  cancellation, so an unreachable Appointment keeps its Slot and waits for a
  human (SPEC.md §14 rule 2).
*/
export const SLOT_FREEING_STATUSES = ["declined", "cancelled"] as const;

export const SLOT_HOLDING_STATUSES = APPOINTMENT_STATUSES.filter(
  (status): status is Exclude<AppointmentStatus, "declined" | "cancelled"> =>
    !SLOT_FREEING_STATUSES.includes(status as (typeof SLOT_FREEING_STATUSES)[number]),
);
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx vitest run lib/db/schema.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/db/schema.ts lib/db/schema.test.ts
git commit -m "Name the statuses that hold a Slot, and pin them to the migration

Availability and the EXCLUDE constraint have to agree about which Appointments
free their Slot. The test parses drizzle/0001 so editing only the SQL fails."
```

---

## Task 3: Slot arithmetic — inside Business Hours, never in the past

The pure core. No database, so these tests run in milliseconds and the daylight-saving cases are assertable without seeding a Business.

**Files:**
- Create: `lib/availability/slots.ts`, `lib/availability/slots.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/availability/slots.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { openSlots, type WeekdayWindow } from "@/lib/availability/slots";

/*
  Pure — no database, no ambient clock. `now` is injected for the reason
  lib/onboarding/seed-schedule.ts gives for doing the same: otherwise
  correctness depends on the day the test runs.

  Times are asserted as instants (toISOString) rather than as formatted local
  strings, because the whole point of this module is the conversion between the
  two and a formatted assertion would hide a wrong conversion.
*/

// A salon open 09:00-17:00 on Monday only. 2026-08-17 is a Monday.
const MONDAY_ONLY: WeekdayWindow[] = [
  { weekday: 1, opensAt: "09:00", closesAt: "17:00" },
];

const LONDON = "Europe/London";
const KOLKATA = "Asia/Kolkata";

const starts = (slots: { startsAt: Date }[]) =>
  slots.map((s) => s.startsAt.toISOString());

describe("openSlots", () => {
  it("steps from opening by the Service's duration", () => {
    const slots = openSlots({
      hours: MONDAY_ONLY,
      timezone: LONDON,
      durationMinutes: 45,
      busy: [],
      // Monday 2026-08-17. London is on BST (+01:00) in August.
      from: new Date("2026-08-17T00:00:00.000Z"),
      to: new Date("2026-08-17T23:59:59.999Z"),
      now: new Date("2026-08-16T00:00:00.000Z"),
    });

    // 09:00 BST is 08:00Z. 45-minute steps, last Slot must end by 17:00 local.
    expect(starts(slots).slice(0, 3)).toEqual([
      "2026-08-17T08:00:00.000Z",
      "2026-08-17T08:45:00.000Z",
      "2026-08-17T09:30:00.000Z",
    ]);

    // 09:00-17:00 is 480 minutes; 480 / 45 = 10 whole Slots.
    expect(slots).toHaveLength(10);
    expect(slots.at(-1)!.endsAt.toISOString()).toBe("2026-08-17T15:30:00.000Z");
  });

  it("never returns a Slot that would end after closing", () => {
    const slots = openSlots({
      hours: [{ weekday: 1, opensAt: "09:00", closesAt: "10:00" }],
      timezone: LONDON,
      durationMinutes: 45,
      busy: [],
      from: new Date("2026-08-17T00:00:00.000Z"),
      to: new Date("2026-08-17T23:59:59.999Z"),
      now: new Date("2026-08-16T00:00:00.000Z"),
    });

    // One 45-minute Slot fits in a 60-minute window. The second would run to
    // 10:30, past closing — SPEC.md §14 rule 1.
    expect(starts(slots)).toEqual(["2026-08-17T08:00:00.000Z"]);
  });

  it("returns nothing on a day the Business is closed", () => {
    const slots = openSlots({
      hours: MONDAY_ONLY,
      timezone: LONDON,
      durationMinutes: 45,
      busy: [],
      // Tuesday.
      from: new Date("2026-08-18T00:00:00.000Z"),
      to: new Date("2026-08-18T23:59:59.999Z"),
      now: new Date("2026-08-16T00:00:00.000Z"),
    });

    expect(slots).toEqual([]);
  });

  it("never returns a Slot in the past", () => {
    const slots = openSlots({
      hours: MONDAY_ONLY,
      timezone: LONDON,
      durationMinutes: 60,
      busy: [],
      from: new Date("2026-08-17T00:00:00.000Z"),
      to: new Date("2026-08-17T23:59:59.999Z"),
      // 11:30 local (10:30Z) — the 09:00 and 10:00 Slots have gone, and 11:00
      // has already started.
      now: new Date("2026-08-17T10:30:00.000Z"),
    });

    expect(starts(slots)[0]).toBe("2026-08-17T11:00:00.000Z");
  });

  it("drops a Slot that overlaps a busy period", () => {
    const slots = openSlots({
      hours: MONDAY_ONLY,
      timezone: LONDON,
      durationMinutes: 60,
      // 09:30-10:30 local. Overlaps the 09:00 and 10:00 Slots, not 11:00.
      busy: [
        {
          startsAt: new Date("2026-08-17T08:30:00.000Z"),
          endsAt: new Date("2026-08-17T09:30:00.000Z"),
        },
      ],
      from: new Date("2026-08-17T00:00:00.000Z"),
      to: new Date("2026-08-17T23:59:59.999Z"),
      now: new Date("2026-08-16T00:00:00.000Z"),
    });

    expect(starts(slots)).not.toContain("2026-08-17T08:00:00.000Z");
    expect(starts(slots)).not.toContain("2026-08-17T09:00:00.000Z");
    expect(starts(slots)).toContain("2026-08-17T10:00:00.000Z");
  });

  it("keeps a Slot that only touches a busy period, never overlapping it", () => {
    const slots = openSlots({
      hours: MONDAY_ONLY,
      timezone: LONDON,
      durationMinutes: 60,
      // Exactly the 09:00-10:00 local Slot.
      busy: [
        {
          startsAt: new Date("2026-08-17T08:00:00.000Z"),
          endsAt: new Date("2026-08-17T09:00:00.000Z"),
        },
      ],
      from: new Date("2026-08-17T00:00:00.000Z"),
      to: new Date("2026-08-17T23:59:59.999Z"),
      now: new Date("2026-08-16T00:00:00.000Z"),
    });

    // Back-to-back is not an overlap: tstzrange is half-open, so the database
    // accepts 10:00 against a 09:00-10:00 Appointment. Availability must agree,
    // or it hides a Slot the database would take.
    expect(starts(slots)).toContain("2026-08-17T09:00:00.000Z");
    expect(starts(slots)).not.toContain("2026-08-17T08:00:00.000Z");
  });

  it("returns nothing when the window ends before it begins", () => {
    const slots = openSlots({
      hours: MONDAY_ONLY,
      timezone: LONDON,
      durationMinutes: 45,
      busy: [],
      from: new Date("2026-08-18T00:00:00.000Z"),
      to: new Date("2026-08-17T00:00:00.000Z"),
      now: new Date("2026-08-16T00:00:00.000Z"),
    });

    expect(slots).toEqual([]);
  });

  it("handles a half-hour offset zone", () => {
    const slots = openSlots({
      hours: MONDAY_ONLY,
      timezone: KOLKATA,
      durationMinutes: 60,
      busy: [],
      from: new Date("2026-08-16T00:00:00.000Z"),
      to: new Date("2026-08-18T00:00:00.000Z"),
      now: new Date("2026-08-15T00:00:00.000Z"),
    });

    // Asia/Kolkata is +05:30 with no DST, so 09:00 local is 03:30Z. Nothing
    // here rounds to whole hours (ADR-0007).
    expect(starts(slots)[0]).toBe("2026-08-17T03:30:00.000Z");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run lib/availability/slots.test.ts
```

Expected: FAIL — cannot resolve `@/lib/availability/slots`.

- [ ] **Step 3: Write the implementation**

Create `lib/availability/slots.ts`:

```ts
import {
  addCalendarDays,
  parseWallTime,
  todayInZone,
  weekdayOf,
  zonedTimeToInstant,
  type CivilDate,
} from "@/lib/time/zone";

/**
 * Slot arithmetic — the pure core of Availability (SPEC.md §6).
 *
 * No database and no clock of its own: `now` is injected, for the reason
 * `lib/onboarding/seed-schedule.ts` gives for doing the same — otherwise
 * correctness depends on the day the test runs. The daylight-saving cases are
 * the substance of this module and they have to be assertable without seeding a
 * Business.
 *
 * **The rule that makes clock changes come out right:** convert each day's
 * opening and closing wall-clock times to instants ONCE, then step forward in
 * real milliseconds. Do not step through wall-clock times and convert each one.
 *
 * Both give identical results on the ~363 ordinary days a year. On the two that
 * matter:
 *
 * - Stepping through wall clocks would land inside the spring-forward gap, where
 *   ADR-0007 resolves a nonexistent time *forward*. Two different wall clocks
 *   can then map to the same instant, so the same Slot gets offered twice, or two
 *   Slots overlap. The database would reject the second booking of a Slot Maya
 *   had just read aloud — SPEC.md §3 rule 7.
 * - Stepping in real milliseconds instead yields one fewer Slot on a
 *   spring-forward day, because the day genuinely contains one hour less. That is
 *   the truth about the day, not a defect.
 *
 * A fall-back day comes out right for the same reason: the day holds 25 real
 * hours, so a window reading 00:00-07:00 on the clock is eight hours long and
 * yields eight Slots. Two of them read as "01:00" locally while being an hour
 * apart in real time, and both are genuinely bookable. Converting wall clocks
 * would have named only the first.
 *
 * Known limitation, narrow: if `opensAt` or `closesAt` ITSELF falls inside a
 * transition — a Business opening at 01:30 on a fall-back day, or at 02:30 on a
 * spring-forward day — ADR-0007's rules apply to that one conversion, so the
 * window comes out an hour longer or shorter than the clock suggests. Accepted;
 * see ADR-0010.
 *
 * Half-hour and quarter-hour zones (Asia/Kolkata +05:30, Asia/Kathmandu +05:45)
 * need no special handling, because nothing here does hour arithmetic.
 */

/** A bookable window, sized by a Service's duration. */
export type Slot = {
  startsAt: Date;
  endsAt: Date;
};

/** One weekday's opening window, wall-clock `"HH:mm"` — never an instant. */
export type WeekdayWindow = {
  /** 0 = Sunday, matching `business_hours.weekday`. */
  weekday: number;
  /** `"09:00"`. */
  opensAt: string;
  /** `"17:00"`. Strictly after `opensAt` — `lib/settings/hours-input.ts` rejects
   *  overnight windows, so every window is same-day. */
  closesAt: string;
};

/** Time already taken — an Appointment whose status holds its Slot. */
export type BusyPeriod = {
  startsAt: Date;
  endsAt: Date;
};

export type OpenSlotsInput = {
  hours: WeekdayWindow[];
  /** IANA zone from `businesses.timezone`. */
  timezone: string;
  durationMinutes: number;
  busy: BusyPeriod[];
  /** Earliest instant to consider. */
  from: Date;
  /** Latest instant a Slot may end at. */
  to: Date;
  /** Now. Slots before this are never returned (SPEC.md §6). */
  now: Date;
};

/*
  A ceiling on how many days one call may walk, so a caller asking for a decade
  cannot spin. 366 covers any sane window and makes the loop obviously finite.
*/
const MAX_DAYS = 366;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/** The open Slots in `[from, to]`, in ascending order. */
export function openSlots({
  hours,
  timezone,
  durationMinutes,
  busy,
  from,
  to,
  now,
}: OpenSlotsInput): Slot[] {
  if (durationMinutes <= 0) {
    throw new Error(
      `A Service duration must be positive, got ${durationMinutes} minutes`,
    );
  }

  // A Slot in the past is never offered, so the search never starts before now.
  const earliest = from.getTime() > now.getTime() ? from : now;
  if (earliest.getTime() >= to.getTime()) return [];

  const windowsByWeekday = new Map(hours.map((h) => [h.weekday, h]));
  const firstDate = todayInZone(earliest, timezone);
  const lastDate = todayInZone(to, timezone);
  const days = Math.min(civilDaysBetween(firstDate, lastDate), MAX_DAYS - 1);

  const slots: Slot[] = [];
  for (let offset = 0; offset <= days; offset++) {
    const date = addCalendarDays(firstDate, offset);
    const window = windowsByWeekday.get(weekdayOf(date));
    if (!window) continue;

    for (const slot of slotsForDay(window, date, timezone, durationMinutes)) {
      if (slot.startsAt.getTime() < earliest.getTime()) continue;
      if (slot.endsAt.getTime() > to.getTime()) continue;
      if (busy.some((period) => overlaps(slot, period))) continue;
      slots.push(slot);
    }
  }

  return slots;
}

/**
 * One day's Slots, stepping in real milliseconds from the opening instant.
 *
 * The opening and closing wall clocks are each converted once. See this module's
 * header for why stepping in real time rather than clock time is what makes
 * daylight-saving days correct.
 */
function slotsForDay(
  window: WeekdayWindow,
  date: CivilDate,
  timezone: string,
  durationMinutes: number,
): Slot[] {
  const opens = parseWallTime(window.opensAt);
  const closes = parseWallTime(window.closesAt);

  const opensAt = zonedTimeToInstant({ ...date, ...opens }, timezone).getTime();
  const closesAt = zonedTimeToInstant({ ...date, ...closes }, timezone).getTime();

  const stepMs = durationMinutes * MS_PER_MINUTE;
  const slots: Slot[] = [];

  // `start + stepMs <= closesAt`, so a Slot that would run past closing is never
  // generated — SPEC.md §14 rule 1, enforced here rather than trusted to a caller.
  for (let start = opensAt; start + stepMs <= closesAt; start += stepMs) {
    slots.push({ startsAt: new Date(start), endsAt: new Date(start + stepMs) });
  }

  return slots;
}

/**
 * Half-open overlap, matching Postgres `tstzrange` and therefore the
 * `appointments_no_overlap` constraint.
 *
 * Touching is not overlapping: a 09:00-10:00 Appointment leaves 10:00-11:00
 * free. Getting this wrong in the strict direction would hide Slots the database
 * would happily take.
 */
function overlaps(slot: Slot, period: BusyPeriod): boolean {
  return (
    slot.startsAt.getTime() < period.endsAt.getTime() &&
    period.startsAt.getTime() < slot.endsAt.getTime()
  );
}

/**
 * Whole calendar days from `a` to `b`, negative if `b` is earlier.
 *
 * Civil arithmetic with no zone involved, for the reason `addCalendarDays` in
 * `lib/time/zone.ts` gives: counting in absolute milliseconds lands on the wrong
 * date across a DST transition.
 */
function civilDaysBetween(a: CivilDate, b: CivilDate): number {
  const from = Date.UTC(a.year, a.month - 1, a.day);
  const to = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((to - from) / MS_PER_DAY);
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx vitest run lib/availability/slots.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/availability/slots.ts lib/availability/slots.test.ts
git commit -m "Add Slot generation — inside Business Hours, never in the past

Pure, with now injected, so the daylight-saving cases are assertable without a
database. Steps in real milliseconds from the opening instant rather than
through wall-clock times: stepping through clock times lands inside the
spring-forward gap, where ADR-0007 resolves forward, and two clock readings can
then map to one instant."
```

---

## Task 4: Daylight saving and the clock that changes

Acceptance criterion 5. These are the tests the "step in real milliseconds" rule exists for, so they go in their own task — if they fail, the rule was implemented wrong.

**Files:**
- Modify: `lib/availability/slots.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `lib/availability/slots.test.ts`:

```ts
describe("openSlots across daylight-saving transitions", () => {
  /*
    Europe/London springs forward on the last Sunday of March. In 2027 that is
    Sunday 28 March: at 01:00 GMT the clock jumps to 02:00 BST, so 01:00-01:59
    local never happens and the day holds 23 hours of real time.
  */
  const SPRING_FORWARD: WeekdayWindow[] = [
    { weekday: 0, opensAt: "00:00", closesAt: "06:00" },
  ];

  it("yields one fewer Slot on a spring-forward day", () => {
    const springForward = openSlots({
      hours: SPRING_FORWARD,
      timezone: LONDON,
      durationMinutes: 60,
      busy: [],
      from: new Date("2027-03-28T00:00:00.000Z"),
      to: new Date("2027-03-28T23:59:59.999Z"),
      now: new Date("2027-03-01T00:00:00.000Z"),
    });

    /*
      Midnight to 06:00 local reads as six hours on the clock but is five hours
      of real time, so five Slots — not six. The day really is shorter; an
      Appointment occupies real time, not clock time.
    */
    expect(springForward).toHaveLength(5);

    // Opens at 00:00 GMT (= 00:00Z), and the clock jump means the 01:00 Slot
    // starts where 02:00 local now reads.
    expect(starts(springForward)).toEqual([
      "2027-03-28T00:00:00.000Z",
      "2027-03-28T01:00:00.000Z",
      "2027-03-28T02:00:00.000Z",
      "2027-03-28T03:00:00.000Z",
      "2027-03-28T04:00:00.000Z",
    ]);
  });

  it("never returns two Slots at the same instant, or overlapping ones", () => {
    const slots = openSlots({
      hours: SPRING_FORWARD,
      timezone: LONDON,
      durationMinutes: 30,
      busy: [],
      from: new Date("2027-03-28T00:00:00.000Z"),
      to: new Date("2027-03-28T23:59:59.999Z"),
      now: new Date("2027-03-01T00:00:00.000Z"),
    });

    /*
      The failure this guards against: if Slots were generated by stepping
      through wall-clock times, the times inside the gap would resolve forward
      onto instants already used, and Maya would offer the same Slot twice or
      offer two that overlap. The database would then reject a booking for a
      time she had just read out.
    */
    const instants = starts(slots);
    expect(new Set(instants).size).toBe(instants.length);

    for (let i = 1; i < slots.length; i++) {
      expect(slots[i].startsAt.getTime()).toBeGreaterThanOrEqual(
        slots[i - 1].endsAt.getTime(),
      );
    }
  });

  it("covers both passes through a repeated fall-back hour", () => {
    /*
      Europe/London falls back on the last Sunday of October — 25 October 2026.
      At 02:00 BST the clock returns to 01:00 GMT, so 01:00-01:59 local happens
      twice and the day holds 25 hours.

      A window reading 00:00-07:00 on the clock is therefore EIGHT real hours,
      and stepping in real time offers all eight. Two of those Slots read as
      "01:00" on the wall clock while being an hour apart in real time — which is
      correct: they are genuinely different, separately bookable hours.

      This is the case that would break if Slots were generated by converting
      wall-clock times, because ADR-0007 resolves an ambiguous wall clock to the
      earlier instant and the second 01:00 would never be named.
    */
    const slots = openSlots({
      hours: [{ weekday: 0, opensAt: "00:00", closesAt: "07:00" }],
      timezone: LONDON,
      durationMinutes: 60,
      busy: [],
      from: new Date("2026-10-24T00:00:00.000Z"),
      to: new Date("2026-10-25T23:59:59.999Z"),
      now: new Date("2026-10-01T00:00:00.000Z"),
    });

    // Eight, not the seven the clock suggests.
    expect(slots).toHaveLength(8);

    // Opens 00:00 BST = 23:00Z the previous day.
    expect(starts(slots)).toEqual([
      "2026-10-24T23:00:00.000Z",
      "2026-10-25T00:00:00.000Z", // 01:00 BST
      "2026-10-25T01:00:00.000Z", // 01:00 GMT — the repeat, still offered
      "2026-10-25T02:00:00.000Z",
      "2026-10-25T03:00:00.000Z",
      "2026-10-25T04:00:00.000Z",
      "2026-10-25T05:00:00.000Z",
      "2026-10-25T06:00:00.000Z",
    ]);

    const instants = starts(slots);
    expect(new Set(instants).size).toBe(instants.length);
  });

  it("keeps every Slot inside Business Hours across a transition", () => {
    const slots = openSlots({
      hours: SPRING_FORWARD,
      timezone: LONDON,
      durationMinutes: 90,
      busy: [],
      from: new Date("2027-03-28T00:00:00.000Z"),
      to: new Date("2027-03-28T23:59:59.999Z"),
      now: new Date("2027-03-01T00:00:00.000Z"),
    });

    // 00:00 GMT to 06:00 BST is five real hours, so three 90-minute Slots fit
    // and the fourth would run past closing.
    expect(slots).toHaveLength(3);
    expect(slots.at(-1)!.endsAt.toISOString()).toBe("2027-03-28T04:30:00.000Z");
  });

  it("handles a quarter-hour offset zone", () => {
    const slots = openSlots({
      hours: [{ weekday: 1, opensAt: "09:00", closesAt: "17:00" }],
      timezone: "Asia/Kathmandu",
      durationMinutes: 60,
      busy: [],
      from: new Date("2026-08-16T00:00:00.000Z"),
      to: new Date("2026-08-18T00:00:00.000Z"),
      now: new Date("2026-08-15T00:00:00.000Z"),
    });

    // +05:45, so 09:00 local is 03:15Z. Nothing rounds to hours (ADR-0007).
    expect(starts(slots)[0]).toBe("2026-08-17T03:15:00.000Z");
  });
});
```

- [ ] **Step 2: Run them**

```bash
npx vitest run lib/availability/slots.test.ts
```

Expected: PASS, 13 tests. They should pass against Task 3's implementation — that is the point, since the rule was designed for exactly these days.

**If one fails on a count, do not change the expected number to match.** Check first whether the implementation is stepping in real milliseconds or in wall-clock time. Verify the transition date independently:

```bash
node -e "for (const h of [0,1,2,3]) { const d = new Date(Date.UTC(2027,2,28,h)); console.log(h + 'Z ->', d.toLocaleString('en-GB', { timeZone: 'Europe/London' })); }"
```

- [ ] **Step 3: Commit**

```bash
git add lib/availability/slots.test.ts
git commit -m "Pin Slot behaviour across daylight-saving transitions

Acceptance criterion 5. A spring-forward day yields one fewer Slot because it
holds one hour less real time, and no two Slots ever share an instant. The
repeated fall-back hour is offered once — ADR-0007 takes the earlier instant —
which is a known limitation, asserted so it changes deliberately."
```

---

## Task 5: Load the real inputs from the database

**Files:**
- Create: `lib/availability/find.ts`

- [ ] **Step 1: Write the implementation**

No test in this step — Task 6 tests it. Write the code first because the test needs a seeded Business and is much easier to read once the signature exists.

Create `lib/availability/find.ts`:

```ts
import { and, eq, gt, inArray, lt } from "drizzle-orm";

import { openSlots, type Slot, type WeekdayWindow } from "@/lib/availability/slots";
import { db, schema } from "@/lib/db";
import { SLOT_HOLDING_STATUSES } from "@/lib/db/schema";
import { toWallTime } from "@/lib/settings/weekdays";

/**
 * Availability for a Business and a Service (SPEC.md §6).
 *
 * Computed entirely from Callzie's own Postgres, never from Google (ADR-0003):
 * `check_availability` runs mid-conversation and a slow answer is dead air.
 *
 * The caller supplies the window. This function owns no policy about how far
 * ahead to look — #10's `check_availability` Tool decides that, and turns its
 * optional `preferred_time` into a window. Keeping the horizon out of here is
 * what lets `lib/availability/slots.ts` stay pure and total.
 */

export type FindAvailableSlotsInput = {
  businessId: string;
  serviceId: string;
  /** Earliest instant to consider. */
  from: Date;
  /** Latest instant a Slot may end at. */
  to: Date;
  /** Injected rather than read, so callers and tests can pin it. */
  now?: Date;
};

export async function findAvailableSlots({
  businessId,
  serviceId,
  from,
  to,
  now = new Date(),
}: FindAvailableSlotsInput): Promise<Slot[]> {
  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.id, businessId),
    columns: { timezone: true },
  });
  if (!business) {
    throw new Error(`No Business ${businessId}`);
  }

  const service = await db.query.services.findFirst({
    where: and(
      eq(schema.services.id, serviceId),
      // Scoped to the Business: a Service id from another account must not
      // resolve, or one Business could read Availability sized by another's
      // duration.
      eq(schema.services.businessId, businessId),
    ),
    columns: { durationMinutes: true },
  });
  if (!service) {
    throw new Error(`No Service ${serviceId} for Business ${businessId}`);
  }

  const hours = await db
    .select({
      weekday: schema.businessHours.weekday,
      opensAt: schema.businessHours.opensAt,
      closesAt: schema.businessHours.closesAt,
    })
    .from(schema.businessHours)
    .where(eq(schema.businessHours.businessId, businessId));

  const busy = await db
    .select({
      startsAt: schema.appointments.startsAt,
      endsAt: schema.appointments.endsAt,
    })
    .from(schema.appointments)
    .where(
      and(
        eq(schema.appointments.businessId, businessId),
        /*
          Exactly the statuses the `appointments_no_overlap` constraint counts —
          see SLOT_HOLDING_STATUSES in lib/db/schema.ts. `declined` and
          `cancelled` free their Slot; everything else holds it, including
          `unreachable` (SPEC.md §14 rule 2).
        */
        inArray(schema.appointments.status, [...SLOT_HOLDING_STATUSES]),
        // Half-open overlap with the window, matching tstzrange. Only
        // Appointments that could touch a Slot in range are loaded.
        lt(schema.appointments.startsAt, to),
        gt(schema.appointments.endsAt, from),
      ),
    );

  return openSlots({
    // pg renders a `time` column as "09:00:00"; the pure core expects "09:00".
    // Normalising on the way out of the database is what toWallTime is for.
    hours: hours.map(
      (h): WeekdayWindow => ({
        weekday: h.weekday,
        opensAt: toWallTime(h.opensAt),
        closesAt: toWallTime(h.closesAt),
      }),
    ),
    timezone: business.timezone,
    durationMinutes: service.durationMinutes,
    busy,
    from,
    to,
    now,
  });
}
```

- [ ] **Step 2: Check it compiles**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/availability/find.ts
git commit -m "Load Business Hours, duration and busy Appointments for Availability

The caller supplies the window; the engine owns no lookahead policy. The busy
query filters on SLOT_HOLDING_STATUSES so it cannot drift from the EXCLUDE
constraint's WHERE clause."
```

---

## Task 6: Prove declined and cancelled Appointments free their Slot

Acceptance criterion 2. This one needs the database.

**Files:**
- Create: `lib/availability/find.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/availability/find.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findAvailableSlots } from "@/lib/availability/find";
import { provisionUser } from "@/lib/auth/provision-user";
import { db, schema } from "@/lib/db";
import { APPOINTMENT_STATUSES, SLOT_FREEING_STATUSES } from "@/lib/db/schema";

/*
  Integration against the local Postgres from vitest.globalSetup.ts.

  The Business is built by hand rather than through createOnboardedBusiness,
  because a Template seeds Appointments of its own and this file needs to control
  exactly which times are taken.
*/

const CLERK_ID = "user_test_availability_find";
const TIMEZONE = "Asia/Kolkata";

// A Monday. Business open 09:00-17:00 every weekday, 60-minute Service.
const MONDAY = new Date("2026-08-17T00:00:00.000Z");
const NOW = new Date("2026-08-16T00:00:00.000Z");
const WINDOW_END = new Date("2026-08-18T00:00:00.000Z");

// 09:00 Asia/Kolkata (+05:30) on that Monday.
const NINE_AM = new Date("2026-08-17T03:30:00.000Z");
const TEN_AM = new Date("2026-08-17T04:30:00.000Z");

let businessId: string;
let serviceId: string;

async function cleanup() {
  const user = await db.query.users.findFirst({
    where: eq(schema.users.clerkId, CLERK_ID),
  });
  if (!user) return;

  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.userId, user.id),
  });
  if (business) {
    // FK order: every FK in this schema is ON DELETE NO ACTION, so children go
    // first or the Business delete fails and poisons the next run.
    await db
      .delete(schema.appointments)
      .where(eq(schema.appointments.businessId, business.id));
    await db.delete(schema.services).where(eq(schema.services.businessId, business.id));
    await db
      .delete(schema.businessHours)
      .where(eq(schema.businessHours.businessId, business.id));
    await db.delete(schema.businesses).where(eq(schema.businesses.id, business.id));
  }
  await db.delete(schema.users).where(eq(schema.users.clerkId, CLERK_ID));
}

beforeEach(async () => {
  await cleanup();
  const user = await provisionUser(CLERK_ID, "availability@example.com");

  const [business] = await db
    .insert(schema.businesses)
    .values({
      userId: user.id,
      name: "Availability Test Salon",
      businessType: "salon",
      timezone: TIMEZONE,
    })
    .returning();
  businessId = business.id;

  await db.insert(schema.businessHours).values(
    [1, 2, 3, 4, 5].map((weekday) => ({
      businessId,
      weekday,
      opensAt: "09:00",
      closesAt: "17:00",
    })),
  );

  const [service] = await db
    .insert(schema.services)
    .values({ businessId, name: "Haircut", durationMinutes: 60 })
    .returning();
  serviceId = service.id;
});

afterEach(cleanup);

function find() {
  return findAvailableSlots({
    businessId,
    serviceId,
    from: MONDAY,
    to: WINDOW_END,
    now: NOW,
  });
}

async function bookDirectly(status: (typeof APPOINTMENT_STATUSES)[number]) {
  await db.insert(schema.appointments).values({
    businessId,
    serviceId,
    name: "Existing Customer",
    phoneE164: "+12025550101",
    startsAt: NINE_AM,
    endsAt: TEN_AM,
    status,
  });
}

describe("findAvailableSlots", () => {
  it("returns Slots inside Business Hours, in the Business's timezone", async () => {
    const slots = await find();

    // 09:00 Asia/Kolkata is 03:30Z — the +05:30 offset, not rounded to an hour.
    expect(slots[0].startsAt.toISOString()).toBe("2026-08-17T03:30:00.000Z");
    // 09:00-17:00 with a 60-minute Service is eight Slots; the last ends at
    // 17:00 local (11:30Z) and none runs past closing.
    expect(slots).toHaveLength(8);
    expect(slots.at(-1)!.endsAt.toISOString()).toBe("2026-08-17T11:30:00.000Z");
  });

  it("returns nothing when the Business has no hours for the day", async () => {
    await db
      .delete(schema.businessHours)
      .where(eq(schema.businessHours.businessId, businessId));

    expect(await find()).toEqual([]);
  });

  it("rejects a Service belonging to another Business", async () => {
    await expect(
      findAvailableSlots({
        businessId,
        serviceId: "00000000-0000-0000-0000-000000000000",
        from: MONDAY,
        to: WINDOW_END,
        now: NOW,
      }),
    ).rejects.toThrow(/No Service/);
  });
});

/*
  The heart of acceptance criterion 2, driven off the status list itself rather
  than a hand-written pair. Adding a status to the schema without deciding
  whether it holds a Slot now fails here.
*/
describe.each(APPOINTMENT_STATUSES)("an Appointment with status %s", (status) => {
  const freesSlot = (SLOT_FREEING_STATUSES as readonly string[]).includes(status);

  it(freesSlot ? "frees its Slot" : "holds its Slot", async () => {
    await bookDirectly(status);
    const slots = await find();
    const nineAm = slots.some(
      (s) => s.startsAt.getTime() === NINE_AM.getTime(),
    );

    expect(nineAm).toBe(freesSlot);
  });
});
```

- [ ] **Step 2: Run it and watch it fail before Task 5's code exists**

If Task 5 is already done this passes immediately. Run it:

```bash
npx vitest run lib/availability/find.test.ts
```

Expected: PASS, 10 tests (3 plus one per status).

If the `describe.each` block fails for `unreachable`, the schema constant is wrong, not the test — `unreachable` must hold its Slot (SPEC.md §14 rule 2).

- [ ] **Step 3: Commit**

```bash
git add lib/availability/find.test.ts
git commit -m "Prove only declined and cancelled Appointments free their Slot

Acceptance criterion 2, driven off APPOINTMENT_STATUSES so adding a status
without deciding whether it holds a Slot fails the suite."
```

---

## Task 7: The booking function

The write path. #10 wraps this in an HTTP Tool endpoint and adds no logic of its own, which is why the concurrency test in Task 8 proves something about production rather than about a test fixture.

**Files:**
- Create: `lib/availability/book.ts`

- [ ] **Step 1: Write the implementation**

Create `lib/availability/book.ts`:

```ts
import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/**
 * Book a Slot (SPEC.md §3 rule 8, §8).
 *
 * The no-overlap guarantee lives in the database, not here. This function does
 * NOT check whether the Slot is free before inserting, and adding such a check
 * would be a mistake: SPEC.md §5 permits three concurrent Calls, and three
 * Agents running check-then-write will find any gap between the read and the
 * write. The `appointments_no_overlap` EXCLUDE constraint closes that gap
 * because Postgres serialises the contending inserts on its gist index.
 *
 * What this function does add is a translation. A losing insert raises a
 * Postgres error, and "someone else just took this Slot" is an ordinary outcome
 * Maya should respond to by offering another time — not an exception. So it comes
 * back as a value, and everything else propagates.
 */

/** Postgres `exclusion_violation`. */
const EXCLUSION_VIOLATION = "23P01";
const NO_OVERLAP_CONSTRAINT = "appointments_no_overlap";

export type BookSlotInput = {
  businessId: string;
  serviceId: string;
  name: string;
  /** E.164 (SPEC.md §3 rule 10). Validated upstream, at the edge that accepts it. */
  phoneE164: string;
  startsAt: Date;
};

export type BookSlotResult =
  | { ok: true; appointment: typeof schema.appointments.$inferSelect }
  | { ok: false; reason: "slot_taken" };

export async function bookSlot({
  businessId,
  serviceId,
  name,
  phoneE164,
  startsAt,
}: BookSlotInput): Promise<BookSlotResult> {
  const service = await db.query.services.findFirst({
    where: and(
      eq(schema.services.id, serviceId),
      eq(schema.services.businessId, businessId),
    ),
    columns: { durationMinutes: true },
  });
  if (!service) {
    throw new Error(`No Service ${serviceId} for Business ${businessId}`);
  }

  /*
    Derived here, never accepted from the caller. `ends_at` is half of what the
    exclusion constraint compares, so a caller able to supply it would be able to
    defeat it — a one-minute end time overlaps nothing.

    Absolute milliseconds, not a wall-clock addition, matching
    lib/onboarding/seed-schedule.ts: an Appointment occupies real time, so a
    90-minute Colour across a spring-forward still takes 90 minutes even though
    the clock advances 150.
  */
  const endsAt = new Date(startsAt.getTime() + service.durationMinutes * 60_000);

  try {
    const [appointment] = await db
      .insert(schema.appointments)
      .values({ businessId, serviceId, name, phoneE164, startsAt, endsAt })
      .returning();
    return { ok: true, appointment };
  } catch (error) {
    if (isSlotTaken(error)) return { ok: false, reason: "slot_taken" };
    // A dropped connection is not a busy Slot. Telling them apart is the whole
    // point of this function: SPEC.md §3 rule 7 says Maya must never claim a
    // booking succeeded when the Tool failed, and §8 retries once before giving
    // up — neither is servable if every error looks the same.
    throw error;
  }
}

/**
 * Whether this error is the no-overlap constraint refusing an overlapping Slot.
 *
 * Both the SQLSTATE and the constraint name are checked. The code alone would
 * also match a future exclusion constraint on some other table, and reading that
 * as "Slot taken" would make Maya offer an alternative time for a problem that
 * has nothing to do with the Slot.
 */
function isSlotTaken(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, constraint } = error as { code?: string; constraint?: string };
  return code === EXCLUSION_VIOLATION && constraint === NO_OVERLAP_CONSTRAINT;
}
```

- [ ] **Step 2: Check it compiles**

```bash
npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/availability/book.ts
git commit -m "Add bookSlot, translating the constraint rejection into a value

Deliberately does not check the Slot is free first — SPEC.md §3 rule 8 puts that
guarantee in the database because three concurrent Agents find any gap between a
check and a write. A losing insert comes back as slot_taken; everything else
propagates, because a dropped connection is not a busy Slot."
```

---

## Task 8: Prove it cannot double-book

Acceptance criteria 3 and 4 — the reason this ticket exists.

**Files:**
- Create: `lib/availability/book.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/availability/book.test.ts`:

```ts
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bookSlot, type BookSlotResult } from "@/lib/availability/book";
import { provisionUser } from "@/lib/auth/provision-user";
import { db, schema } from "@/lib/db";

/*
  Acceptance criteria 3 and 4, against the local Postgres from
  vitest.globalSetup.ts.

  This file DROPS `appointments_no_overlap` in one test and restores it
  afterwards. That is only safe because the database is local and disposable —
  never run this against Cloud SQL, where it would open a window in which the
  live site can genuinely double-book. vitest.globalSetup.ts drops and
  re-migrates the database on every run, so even a crash mid-test cannot leave
  the constraint missing.
*/

const CLERK_ID = "user_test_availability_book";
const TIMEZONE = "Asia/Kolkata";

// 09:00 Asia/Kolkata on Monday 2026-08-17, with a 60-minute Service.
const SLOT_START = new Date("2026-08-17T03:30:00.000Z");

// SPEC.md §5 permits three concurrent Calls, so three is the number that matters.
const CONCURRENT_CALLS = 3;

let businessId: string;
let serviceId: string;

async function cleanup() {
  const user = await db.query.users.findFirst({
    where: eq(schema.users.clerkId, CLERK_ID),
  });
  if (!user) return;

  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.userId, user.id),
  });
  if (business) {
    await db
      .delete(schema.appointments)
      .where(eq(schema.appointments.businessId, business.id));
    await db.delete(schema.services).where(eq(schema.services.businessId, business.id));
    await db
      .delete(schema.businessHours)
      .where(eq(schema.businessHours.businessId, business.id));
    await db.delete(schema.businesses).where(eq(schema.businesses.id, business.id));
  }
  await db.delete(schema.users).where(eq(schema.users.clerkId, CLERK_ID));
}

/** Whether the EXCLUDE constraint is currently on the table. */
async function constraintExists(): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1 FROM pg_constraint WHERE conname = 'appointments_no_overlap'
  `);
  return result.rows.length > 0;
}

async function restoreConstraint() {
  if (await constraintExists()) return;
  await db.execute(sql`
    ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_overlap"
      EXCLUDE USING gist (
        "business_id" WITH =,
        tstzrange("starts_at", "ends_at") WITH &&
      ) WHERE (status NOT IN ('declined', 'cancelled'))
  `);
}

beforeEach(async () => {
  await cleanup();
  const user = await provisionUser(CLERK_ID, "booking@example.com");

  const [business] = await db
    .insert(schema.businesses)
    .values({
      userId: user.id,
      name: "Booking Test Salon",
      businessType: "salon",
      timezone: TIMEZONE,
    })
    .returning();
  businessId = business.id;

  const [service] = await db
    .insert(schema.services)
    .values({ businessId, name: "Haircut", durationMinutes: 60 })
    .returning();
  serviceId = service.id;
});

afterEach(async () => {
  await cleanup();
  // Restore before the next file runs, whatever happened above.
  await restoreConstraint();
});

/** Fire N bookings at the same Slot, as concurrently as the pool allows. */
function raceForTheSameSlot(count = CONCURRENT_CALLS) {
  return Promise.all(
    Array.from({ length: count }, (_, i) =>
      bookSlot({
        businessId,
        serviceId,
        name: `Caller ${i + 1}`,
        phoneE164: `+1202555010${i + 1}`,
        startsAt: SLOT_START,
      }),
    ),
  );
}

async function appointmentsAtTheSlot() {
  return db
    .select()
    .from(schema.appointments)
    .where(eq(schema.appointments.startsAt, SLOT_START));
}

describe("bookSlot under concurrency", () => {
  it("lets exactly one of three simultaneous bookings win", async () => {
    const results = await raceForTheSameSlot();

    /*
      Genuine contention, not sequencing: each insert takes its own connection
      from the pool, and Postgres serialises them on the gist index rather than
      the application ordering them. Same technique as
      create-business.test.ts:182, which races two onboarding submits.
    */
    // Type predicates, not a bare `r => r.ok`: without them TypeScript keeps the
    // union and `won[0].appointment` does not compile.
    const won = results.filter((r): r is Extract<BookSlotResult, { ok: true }> => r.ok);
    const lost = results.filter((r): r is Extract<BookSlotResult, { ok: false }> => !r.ok);

    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(CONCURRENT_CALLS - 1);
    for (const result of lost) {
      expect(result).toEqual({ ok: false, reason: "slot_taken" });
    }

    // And the database agrees — one row, not three.
    expect(await appointmentsAtTheSlot()).toHaveLength(1);
  });

  it("reports the loss as a value, never as a thrown error", async () => {
    // Maya must be able to respond to a lost Slot by offering another time
    // (SPEC.md §8). An exception would surface as a Tool failure instead, and
    // §3 rule 7 turns that into "someone will call you back".
    await expect(raceForTheSameSlot()).resolves.toBeDefined();
  });

  it("frees the Slot once the winner is cancelled", async () => {
    const [winner] = (await raceForTheSameSlot()).filter(
      (r): r is Extract<BookSlotResult, { ok: true }> => r.ok,
    );
    expect(winner).toBeDefined();

    await db
      .update(schema.appointments)
      .set({ status: "cancelled" })
      .where(eq(schema.appointments.id, winner.appointment.id));

    // The constraint exempts cancelled rows, so the Slot is bookable again.
    const second = await bookSlot({
      businessId,
      serviceId,
      name: "Later Caller",
      phoneE164: "+12025550199",
      startsAt: SLOT_START,
    });

    expect(second.ok).toBe(true);
  });
});

/*
  Acceptance criterion 4. Without this, the test above could be passing because
  bookSlot happens to serialise its own writes — and it would keep passing if
  someone removed the constraint.
*/
describe("the constraint, not the code, is what prevents the double-book", () => {
  it("double-books once the constraint is removed", async () => {
    expect(await constraintExists()).toBe(true);

    await db.execute(sql`
      ALTER TABLE "appointments" DROP CONSTRAINT "appointments_no_overlap"
    `);
    expect(await constraintExists()).toBe(false);

    const results = await raceForTheSameSlot();

    /*
      The defect, reproduced. With nothing in the database stopping it, more
      than one booking lands on the same Slot — which is what proves the test
      above is testing the constraint rather than the application's ordering.
    */
    expect(results.filter((r) => r.ok).length).toBeGreaterThan(1);
    expect((await appointmentsAtTheSlot()).length).toBeGreaterThan(1);
  });

  it("has the constraint back afterwards", async () => {
    // afterEach restores it. This asserts the restore actually works, so the
    // test above cannot silently disarm every later file.
    expect(await constraintExists()).toBe(true);
  });
});
```

- [ ] **Step 2: Run it**

```bash
npx vitest run lib/availability/book.test.ts
```

Expected: PASS, 5 tests.

Two failures worth recognising:

- **All three bookings succeed in the first test.** The constraint is missing. Check migration `0001` ran — `globalSetup` uses `migrate()`, and `0001` must be listed in `drizzle/meta/_journal.json`.
- **`db.execute(...).rows` is undefined.** Drizzle's `execute` return shape differs by driver. Check what `node-postgres` returns and adjust `constraintExists` — the query itself is right.

- [ ] **Step 3: Verify the whole suite still passes, constraint intact**

```bash
npm test
```

Expected: every test passes. This matters more than usual here: if `afterEach` failed to restore the constraint, another file would start seeing double-bookings.

- [ ] **Step 4: Commit**

```bash
git add lib/availability/book.test.ts
git commit -m "Prove the database prevents the double-book, not the code

Acceptance criteria 3 and 4. Three simultaneous bookings at one Slot; exactly
one wins. Then the constraint is dropped and the same race double-books —
which is what shows the first test is sensitive to the constraint rather than
to bookSlot's own ordering. Restored in afterEach, and globalSetup re-migrates
every run so a crash cannot leave it missing."
```

---

## Task 9: Record the decisions

**Files:**
- Create: `docs/adr/0010-availability-steps-in-real-time-not-wall-clock.md`
- Modify: `CONTEXT.md`

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0010-availability-steps-in-real-time-not-wall-clock.md`:

```markdown
# ADR-0010: Availability steps in real time, and tests run on a local Postgres

**Status:** Accepted
**Date:** 2026-08-17
**Relates to:** SPEC.md §6, §3 rule 8, §14 rule 1; ADR-0007; issue #6

## Context

SPEC.md §6 requires candidate Slots generated "from `business_hours` in the
Business's timezone, at the Service's duration". Business Hours are wall-clock
times; Appointments are `timestamptz`. ADR-0007 built `lib/time/zone.ts` to cross
that line and anticipated this ticket leaning on it harder.

Two decisions had to be made that ADR-0007 did not settle.

## Decision 1: step in real milliseconds, not through wall-clock times

Convert each day's opening and closing wall clock to an instant once, then add
`durationMinutes` in milliseconds.

The rejected alternative — walking wall-clock times (09:00, 09:45, 10:30) and
converting each — gives identical results on ~363 days a year and is wrong on the
other two. Inside a spring-forward gap ADR-0007 resolves a nonexistent wall clock
*forward*, so two distinct wall clocks can map to the same instant. Availability
would offer one Slot twice, or offer two that overlap, and the database would
then reject a booking for a time Maya had just read aloud — SPEC.md §3 rule 7,
the most damaging failure available to this product.

Stepping in real time yields one fewer Slot on a spring-forward day, because the
day contains one hour less real time. That is a fact about the day.

This also matches `lib/onboarding/seed-schedule.ts`, which derives `endsAt` in
absolute milliseconds for the same stated reason: an Appointment occupies real
time.

### The fall-back day falls out correctly, and that is the strongest argument

An autumn fall-back day holds 25 real hours, so a window reading 00:00–07:00 on
the clock is eight hours long and yields eight Slots. Two read as "01:00"
locally while being an hour apart in real time, and both are separately
bookable — which is the truth about that day.

Converting wall clocks would have named only the first, because ADR-0007 takes
the earlier instant for an ambiguous time. So real-time stepping is not merely
safer against the spring gap; it is the only one of the two that offers a
fall-back day's full availability. Asserted in `lib/availability/slots.test.ts`.

### Accepted limitation, narrow

If `opens_at` or `closes_at` itself falls inside a transition — a Business
opening at 01:30 on a fall-back day, or at 02:30 on a spring-forward day —
ADR-0007's disambiguation applies to that single conversion and the window comes
out an hour longer or shorter than the clock reads. Not worth a disambiguation
parameter threaded through the engine: Businesses open at 09:00, and the four
shipped Templates all do.

## Decision 2: candidates step by the Service's duration

A 45-minute Haircut in a 09:00–17:00 salon yields 09:00, 09:45, 10:30. This is
SPEC.md §6 read literally.

Accepted cost: an off-grid Appointment wastes some bookable time — a 09:45
booking blocks the 09:45 candidate and the 30 free minutes before it are never
offered. Acceptable because `check_availability` returns at most three Slots
(SPEC.md §7), so density is not the binding constraint.

Rejected: a fixed 15-minute grid, which introduces a granularity constant
SPEC.md never mentions; and gap-packing, which is denser but makes the same day
offer different Slot times before and after a booking lands.

## Decision 3: the test suite runs Postgres locally

`embedded-postgres`, pinned to 16.14 to match production's `POSTGRES_16`, started
by `vitest.globalSetup.ts`.

Three reasons, in order of weight:

1. **The concurrency test has to be able to drop the constraint.** Proving the
   test is sensitive to `appointments_no_overlap` means removing it. Against the
   Cloud SQL instance that backs the live URL, that opens a window in which
   Callzie can genuinely double-book, and a crashed run leaves it open.
2. **Issue #6 requires the suite to run with no network access.**
3. **Speed.** A local round trip is sub-millisecond against tens of milliseconds
   through the Cloud SQL Auth Proxy, which is why the old timeouts were 30s.

Rejected: Docker (not installed, and needs WSL on Windows 11 Home); a `winget`
Postgres install (registers a service on 5432, colliding with the Cloud SQL Auth
Proxy that `scripts/setup-infrastructure.sh` tells the developer to run there);
PGlite (`btree_gist` support unverified, and the ticket cannot proceed without
it); a second database on the existing instance (safe for the constraint, but
still needs the proxy).

The cluster persists in `.pgdata/` so `initdb` is paid once, but the *database*
is dropped and re-migrated every run. That is a correctness requirement: if a run
died between dropping the constraint and restoring it, a reused database would
keep migration `0001` recorded as applied and the constraint would never come
back — every later run passing while testing a database with no no-overlap
guarantee.

## Consequences

- Running the suite no longer needs the Cloud SQL Auth Proxy. `.env.local`'s
  `DATABASE_URL` is ignored by tests; `globalSetup` overwrites it.
- The local Postgres is a third-party build (zonky, via `embedded-postgres`) of
  the same major version as production, not the same binary.
- `embedded-postgres` publishes only `-beta.N` versions. Pinned exactly.
- CI becomes possible, since the suite has no external dependency. Not wired up.

## Revisit if

- `Temporal` lands in the deployed runtime. Decision 1 stays correct but could be
  expressed with explicit disambiguation, which would also fix the narrow case of
  a window opening or closing inside a transition.
- A Business asks for Slots at a finer granularity than its Service durations, at
  which point Decision 2's grid deserves reopening.
```

- [ ] **Step 2: Remove the stale PENDING block from CONTEXT.md**

Delete the entire HTML comment block at the foot of `CONTEXT.md` (lines 126–132), the one beginning `PENDING — do not use these terms until settled:`.

It tells readers not to use Appointment, Availability, Slot, Service or Reschedule. Both blockers it names have resolved — the calendar-ownership boundary by ADR-0004, the role split by SPEC.md §14 rule 9 — the terms are already defined in the body above it, and this ticket implements them. Leaving it would tell the next reader that the vocabulary this feature is built on is not settled.

- [ ] **Step 3: Commit**

```bash
git add docs/adr/0010-availability-steps-in-real-time-not-wall-clock.md CONTEXT.md
git commit -m "Record ADR-0010 and retire CONTEXT.md's PENDING block

Three decisions: Slots step in real milliseconds rather than through wall-clock
times, candidates step by the Service's duration, and tests run Postgres
locally. The PENDING block's two blockers resolved in ADR-0004 and SPEC.md §14
rule 9, and this ticket implements the terms it warns against."
```

---

## Task 10: Final verification

- [ ] **Step 1: Full suite, no network**

Stop the Cloud SQL Auth Proxy. Then:

```bash
npm test
```

Expected: every test passes. Acceptance criterion 6.

- [ ] **Step 2: Types and lint**

```bash
npm run typecheck && npm run lint
```

Expected: both clean.

- [ ] **Step 3: Confirm the suite is genuinely offline**

The strongest available check short of a firewall rule — confirm no test reads a Cloud SQL URL:

```bash
git grep -n "DATABASE_URL" -- "*.ts" "*.mts" | grep -v node_modules
```

Expected: only `lib/db/index.ts` (reads it), `vitest.globalSetup.ts` (sets it), and `vitest.setup.ts` (comment).

- [ ] **Step 4: Walk the acceptance criteria**

Check each against a test that proves it:

| Criterion | Proven by |
|---|---|
| Slots inside Business Hours, in the Business's timezone, never in the past | `slots.test.ts`, `find.test.ts` first test |
| A Slot overlapping a live Appointment is never returned; declined or cancelled is | `find.test.ts` `describe.each` over every status |
| Simultaneous bookings, exactly one succeeds | `book.test.ts` "lets exactly one of three simultaneous bookings win" |
| Removing the constraint makes that test fail | `book.test.ts` "double-books once the constraint is removed" |
| Daylight saving and non-hour offsets behave correctly | `slots.test.ts` transition block, Kolkata and Kathmandu tests |
| The whole suite runs with no network access | Step 1 above |

- [ ] **Step 5: Push and open the pull request**

```bash
git push -u origin anushapundir/availability-engine-and-the-no-overlap-constrain
gh pr create --title "Availability engine and the no-overlap constraint" --body "$(cat <<'EOF'
Closes #6.

Given a Business and a Service, return the open Slots — and prove with tests
that the database, not the application, is what stops two Calls booking the
same Slot.

## What is here

- `lib/availability/slots.ts` — pure Slot arithmetic, no database, `now`
  injected. Steps in real milliseconds from each day's opening instant.
- `lib/availability/find.ts` — loads Business Hours, Service duration and busy
  Appointments; the caller supplies the window.
- `lib/availability/book.ts` — inserts the Appointment and translates SQLSTATE
  `23P01` on `appointments_no_overlap` into `slot_taken`. It deliberately does
  not check the Slot is free first.
- The suite now runs Postgres locally, so it needs no network and the
  constraint can be dropped and restored safely.

## The part worth reviewing closely

`book.test.ts` fires three concurrent bookings at one Slot and asserts exactly
one wins. A second test drops `appointments_no_overlap` and asserts the same
race double-books — that is what shows the first test is sensitive to the
constraint rather than to `bookSlot`'s own ordering.

## Known limitations, decided deliberately

- A window whose opening or closing time falls inside a DST transition comes out
  an hour off. No shipped Template opens at 01:30.
- Candidates step by the Service's duration, so an off-grid Appointment wastes
  some bookable time.

See ADR-0010 and `docs/superpowers/specs/2026-08-17-availability-engine-design.md`.

No Retell, no Anthropic, no telephony — this ticket costs nothing to run.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Notes for whoever executes this

**Do not add a date library.** `lib/time/zone.ts` has everything, and ADR-0007
records why the repo carries none.

**Do not add an availability check inside `bookSlot`.** It looks like an
improvement and it is the exact mistake SPEC.md §3 rule 8 exists to prevent.

**If a daylight-saving test fails on a count, do not edit the expected number
first.** Verify the transition independently with `toLocaleString` and check
whether the implementation is stepping in real time or clock time.

**Never point this suite at Cloud SQL.** Task 8 drops a constraint.
