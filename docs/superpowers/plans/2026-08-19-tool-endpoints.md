# Tool Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the four HTTP endpoints Maya calls mid-conversation — `check_availability`, `book_slot`, `confirm_appointment`, `cancel_appointment` — with no voice involved and no telephony spend.

**Architecture:** Four thin route handlers over a shared front door: authenticate with a secret, resolve identity from the `call` object Retell sends, then run one handler inside a single Postgres transaction that also writes the `tool_invocations` record. Two rules the endpoints enforce rather than ask the prompt for: no booking outside Business Hours, and exactly one committed Reschedule per Call.

**Tech Stack:** Next.js 16 route handlers, TypeScript, Drizzle ORM, Postgres 16 (local `embedded-postgres` in tests), Vitest.

**Design doc:** `docs/superpowers/specs/2026-08-19-tool-endpoints-design.md`

---

## Before you start

**Read these first:**

- `docs/superpowers/specs/2026-08-19-tool-endpoints-design.md` — the design and why each choice was made.
- `lib/retell/tools.ts` — the contract. Tool names, argument schemas and URL paths are already fixed here. Do not change them.
- `docs/verification.md` A12 — what Retell actually posts to a custom tool.
- `lib/availability/book.ts` — how a constraint rejection becomes an ordinary return value.
- `SPEC.md` §3 rules 6, 7 and 8; §8; §14 rules 1 and 4.

**Vocabulary** (`CONTEXT.md`): **Slot**, **Offer**, **Reschedule**, **Appointment**, **Business Hours**, **Tool**, **Call**. Not "booking", "opening", "rebook".

**Three terms you will need:**

- **EXCLUDE constraint** — a Postgres rule that refuses a row whose time range overlaps a row already there. Already installed as `appointments_no_overlap`.
- **Partial unique index** — a uniqueness rule that only applies to rows matching a condition. Task 1 adds one.
- **Savepoint** — a marker inside a transaction you can roll back to without losing the whole transaction. Task 8 needs one, and the reason is in that task.

**Run the tests with:** `npm test`. A single file: `npx vitest run lib/tools/auth.test.ts`.

---

## File Structure

| File | Responsibility |
|---|---|
| `drizzle/0003_tool_invocations.sql` | **New.** `latency_ms` column; the one-booking partial unique index. |
| `drizzle/meta/_journal.json` | **Modify.** Register `0003`. |
| `lib/db/schema.ts` | **Modify.** `latencyMs` on `toolInvocations`. |
| `lib/db/schema.test.ts` | **Modify.** Assert migration `0003`'s `WHERE` clause still says what the code assumes. |
| `lib/availability/slot-taken.ts` | **New.** `isSlotTaken`, moved out of `book.ts` so two callers share one copy. |
| `lib/availability/book.ts` | **Modify.** Import it instead of defining it. |
| `lib/tools/spoken-time.ts` | **New.** An instant rendered the way Maya says it. |
| `lib/tools/auth.ts` | **New.** The secret check, from either header. |
| `lib/tools/testing.ts` | **New.** Seed and clean up a Business + Appointment + Call. Test-only. |
| `lib/tools/request.ts` | **New.** Parse `{ name, call, args }`; resolve the Call to its Appointment, Business and Service. |
| `lib/tools/run.ts` | **New.** One transaction per Tool call, which also writes the record. |
| `lib/appointments/reschedule.ts` | **New.** Move an Appointment; translate the constraint rejection. |
| `lib/tools/offers.ts` | **New.** Which `slot_start` values this Call was actually offered. |
| `lib/tools/check-availability.ts` | **New.** Up to three open Slots. |
| `lib/tools/book-slot.ts` | **New.** Four checks, one silent retry, `book_failed`. |
| `lib/tools/confirm-appointment.ts` | **New.** |
| `lib/tools/cancel-appointment.ts` | **New.** |
| `lib/tools/handle.ts` | **New.** The shared front door every route calls. |
| `app/api/tools/*/route.ts` | **New.** Four files, three lines each. |
| `proxy.ts` | **Modify.** `/api/tools(.*)` joins the public list. |
| `fixtures/retell/tools/*.json` | **New.** Request bodies as Retell sends them. |
| `docs/adr/0011-tools-prove-an-offer-by-replaying-tool-invocations.md` | **New.** |
| `docs/verification.md` | **Modify.** Close two open items in A12. |

**Task order matters.** Task 1 must come first — every later test needs `latency_ms` to exist.

---

### Task 1: The migration

**Files:**
- Create: `drizzle/0003_tool_invocations.sql`
- Modify: `drizzle/meta/_journal.json`
- Modify: `lib/db/schema.ts`
- Test: `lib/db/schema.test.ts`

- [x] **Step 1: Write the migration**

`drizzle/0003_tool_invocations.sql`:

```sql
-- Hand-written, following drizzle/0001's precedent: a partial unique index is a
-- rule Drizzle's schema DSL does not round-trip cleanly, and this one is
-- load-bearing enough to be worth reading as SQL.
--
-- `latency_ms` — issue #10 requires latency to be recorded, and
-- docs/verification.md A12 names this ticket as what settles the Tool latency
-- budget. Nullable on purpose: a row written after a crash may have nothing to
-- record, and NOT NULL would turn a failed Tool into a failed record of one.

ALTER TABLE "tool_invocations" ADD COLUMN "latency_ms" integer;
--> statement-breakpoint
-- CONTEXT.md: "One Reschedule commits per Call, however many Offers preceded
-- it." Enforced here rather than in application code for the same reason
-- appointments_no_overlap is — a check in code is a check someone can delete
-- without a test going red.
--
-- Read the WHERE clause carefully; it is the whole design:
--   * unlimited check_availability rows per Call — the negotiation is the
--     product's best moment (SPEC.md §7) and nothing may cap it;
--   * unlimited FAILED book_slot rows — SPEC.md §8 retries once, and losing a
--     Slot to a concurrent Call is an ordinary outcome Maya answers by offering
--     another time;
--   * exactly one SUCCESSFUL book_slot.
CREATE UNIQUE INDEX "tool_invocations_one_booking_per_call"
  ON "tool_invocations" ("call_id")
  WHERE "tool_name" = 'book_slot' AND "succeeded";
```

- [x] **Step 2: Register it in the journal**

Add to the `entries` array in `drizzle/meta/_journal.json`, after the `0002` entry:

```json
    {
      "idx": 3,
      "version": "7",
      "when": 1787097600000,
      "tag": "0003_tool_invocations",
      "breakpoints": true
    }
```

- [x] **Step 3: Add the column to the schema**

In `lib/db/schema.ts`, inside `toolInvocations`, after `succeeded`:

```ts
    // How long the endpoint took, in milliseconds. A slow Tool is dead air on a
    // live call (issue #10), and docs/verification.md A12 records the latency
    // budget as unverified — this column is what will settle it.
    latencyMs: integer("latency_ms"),
```

- [x] **Step 4: Write the failing test**

Append to `lib/db/schema.test.ts`:

```ts
const TOOL_MIGRATION = readFileSync("./drizzle/0003_tool_invocations.sql", "utf8");

describe("the one-booking-per-call index", () => {
  it("applies only to successful book_slot rows", () => {
    // lib/tools/run.ts relies on exactly this condition. If someone widens it to
    // every book_slot row, SPEC.md §8's silent retry stops working; if they drop
    // `succeeded`, a Call can commit two Reschedules. Neither would fail to
    // compile.
    const where = /CREATE UNIQUE INDEX "tool_invocations_one_booking_per_call"[\s\S]*?WHERE ([^;]+)/
      .exec(TOOL_MIGRATION);
    expect(where, "migration 0003 no longer creates that index").not.toBeNull();

    const clause = where![1].replace(/\s+/g, " ").trim();
    expect(clause).toContain("\"tool_name\" = 'book_slot'");
    expect(clause).toContain("\"succeeded\"");
  });

  it("is keyed on the Call, not the Appointment", () => {
    // Per Call is the rule CONTEXT.md states. Per Appointment would refuse a
    // legitimate second Reschedule on a later Call.
    expect(TOOL_MIGRATION).toMatch(/ON "tool_invocations" \("call_id"\)/);
  });
});
```

- [x] **Step 5: Run it**

Run: `npx vitest run lib/db/schema.test.ts`
Expected: PASS once the file exists. If the migration is malformed, `npm test` fails at `globalSetup` instead, with Postgres's own error.

- [x] **Step 6: Prove the migration loads**

Run: `npm test`
Expected: the whole existing suite still passes. `vitest.globalSetup.ts` drops and re-migrates the database every run, so a broken `0003` fails loudly here.

- [x] **Step 7: Commit**

```bash
git add drizzle/0003_tool_invocations.sql drizzle/meta/_journal.json lib/db/schema.ts lib/db/schema.test.ts
git commit -m "Record Tool latency, and make one Reschedule per Call a database rule"
```

---

### Task 2: Share `isSlotTaken`

`lib/appointments/reschedule.ts` needs the same constraint-error translation `lib/availability/book.ts` already has. Move it rather than copy it — a copy is one of two places to fix.

**Files:**
- Create: `lib/availability/slot-taken.ts`
- Modify: `lib/availability/book.ts`

- [x] **Step 1: Create the new file**

`lib/availability/slot-taken.ts` — move the constants and `isSlotTaken` out of `book.ts` **verbatim**, including the whole comment block, and export the function. Add this header:

```ts
/**
 * Whether an error is the no-overlap constraint refusing an overlapping Slot.
 *
 * Its own file because two writers need it: `lib/availability/book.ts` inserts a
 * new Appointment, and `lib/appointments/reschedule.ts` moves an existing one.
 * Both hit `appointments_no_overlap`, and both have to tell "someone took that
 * Slot" apart from "the connection dropped" — SPEC.md §3 rule 7 says Maya must
 * never claim a booking succeeded when the Tool failed, and §8 retries once
 * before giving up. Neither is servable if every error looks the same.
 */
```

- [x] **Step 2: Import it in `book.ts`**

Delete `EXCLUSION_VIOLATION`, `NO_OVERLAP_CONSTRAINT` and `isSlotTaken` from `lib/availability/book.ts`, and add at the top:

```ts
import { isSlotTaken } from "@/lib/availability/slot-taken";
```

- [x] **Step 3: Run the existing tests**

Run: `npx vitest run lib/availability/book.test.ts`
Expected: PASS, unchanged. This is a move, not a change — the concurrency test is what proves it.

- [x] **Step 4: Commit**

```bash
git add lib/availability/slot-taken.ts lib/availability/book.ts
git commit -m "Give isSlotTaken its own file, so the reschedule path can share it"
```

---

### Task 3: `spokenTime`

**Files:**
- Create: `lib/tools/spoken-time.ts`
- Test: `lib/tools/spoken-time.test.ts`

- [x] **Step 1: Write the failing test**

`lib/tools/spoken-time.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { spokenTime } from "@/lib/tools/spoken-time";

/*
  Pure. No database, no clock of its own.

  This exists because `formatInZone` in lib/time/zone.ts cannot be reused here.
  That one renders "Thu 20 Aug, 14:00" — fixed-width and 24-hour, correct for a
  dashboard table in a mono face, and wrong to read down a phone line.
*/

// 14:00 Asia/Kolkata on Thursday 2026-08-20. +05:30, which is the offset a
// formatter that rounds to whole hours gets wrong — and Callzie's first market.
const AFTERNOON = new Date("2026-08-20T08:30:00.000Z");

describe("spokenTime", () => {
  it("names the day, the date and a 12-hour time", () => {
    expect(spokenTime(AFTERNOON, "Asia/Kolkata")).toBe(
      "Thursday 20 August at 2:00 PM",
    );
  });

  it("renders the same instant differently in another zone", () => {
    // Maya reads Business-local time. The instant is not the sentence.
    expect(spokenTime(AFTERNOON, "Europe/London")).toBe(
      "Thursday 20 August at 9:30 AM",
    );
  });

  it("says 12 AM for midnight, not 0 AM", () => {
    expect(spokenTime(new Date("2026-08-19T18:30:00.000Z"), "Asia/Kolkata")).toBe(
      "Thursday 20 August at 12:00 AM",
    );
  });

  it("says 12 PM for noon", () => {
    expect(spokenTime(new Date("2026-08-20T06:30:00.000Z"), "Asia/Kolkata")).toBe(
      "Thursday 20 August at 12:00 PM",
    );
  });

  it("uses the offset in force at the instant, not an average", () => {
    // 2026-11-01 is the US fall-back. 09:00 local on either side of it is a
    // different UTC instant, and both must read back as 9:00 AM.
    expect(spokenTime(new Date("2026-10-31T13:00:00.000Z"), "America/New_York")).toBe(
      "Saturday 31 October at 9:00 AM",
    );
    expect(spokenTime(new Date("2026-11-01T14:00:00.000Z"), "America/New_York")).toBe(
      "Sunday 1 November at 9:00 AM",
    );
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/tools/spoken-time.test.ts`
Expected: FAIL — cannot resolve `@/lib/tools/spoken-time`.

- [x] **Step 3: Implement it**

`lib/tools/spoken-time.ts`:

```ts
/**
 * An instant rendered the way Maya says it out loud, in a Business's own
 * timezone — "Thursday 20 August at 2:00 PM".
 *
 * Deliberately not `formatInZone` from `lib/time/zone.ts`. That one produces
 * "Thu 20 Aug, 14:00": fixed-width and 24-hour, which is right for a dashboard
 * table in a mono face (SPEC.md §11.3) and wrong down a phone line. The two
 * formats have opposite requirements, so they are two functions.
 *
 * Assembled from `formatToParts` rather than taken as one formatted string,
 * because locales disagree about the separator between the date and the time,
 * and one of the two would end up reading oddly. Assembling makes the output the
 * same sentence in every environment, which also makes it assertable.
 */

const SPOKEN_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = SPOKEN_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      weekday: "long",
      day: "numeric",
      month: "long",
      // "numeric", not "2-digit": "2:00 PM" is what a person says, "02:00 PM"
      // is what a machine writes.
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    SPOKEN_FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

export function spokenTime(instant: Date, timeZone: string): string {
  const parts = formatterFor(timeZone).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((p) => p.type === type);
    if (!part) {
      throw new Error(`Intl returned no "${type}" part for zone "${timeZone}"`);
    }
    return part.value;
  };

  // Some ICU builds render the day period as "am"/"pm", others as "a.m.".
  // Normalised, because this string is compared in tests and spoken by a model.
  const period = read("dayPeriod").replace(/\./g, "").toUpperCase();

  return `${read("weekday")} ${read("day")} ${read("month")} at ${read("hour")}:${read("minute")} ${period}`;
}
```

- [x] **Step 4: Run it to verify it passes**

Run: `npx vitest run lib/tools/spoken-time.test.ts`
Expected: PASS, 5 tests.

- [x] **Step 5: Commit**

```bash
git add lib/tools/spoken-time.ts lib/tools/spoken-time.test.ts
git commit -m "Render a Slot the way Maya says it, not the way the table shows it"
```

---

### Task 4: The secret check

**Files:**
- Create: `lib/tools/auth.ts`
- Test: `lib/tools/auth.test.ts`

- [x] **Step 1: Write the failing test**

`lib/tools/auth.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { isAuthorised } from "@/lib/tools/auth";

/*
  Acceptance criterion 1: each endpoint is reachable only with the internal
  secret, and rejects unauthenticated calls.

  Both headers are accepted because docs/verification.md A12 records it as
  UNVERIFIED whether Retell forwards `Authorization` unmodified, and names
  `X-Callzie-Secret` as the fallback. Finding out during a live call would mean
  re-provisioning four Agents to fix it.
*/

const SECRET = "test-internal-secret-value";

function post(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/tools/check-availability", {
    method: "POST",
    headers,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isAuthorised", () => {
  it("accepts the secret as a Bearer token", () => {
    vi.stubEnv("INTERNAL_SECRET", SECRET);
    expect(isAuthorised(post({ Authorization: `Bearer ${SECRET}` }))).toBe(true);
  });

  it("accepts the secret in X-Callzie-Secret", () => {
    vi.stubEnv("INTERNAL_SECRET", SECRET);
    expect(isAuthorised(post({ "X-Callzie-Secret": SECRET }))).toBe(true);
  });

  it("refuses a request with no credential at all", () => {
    vi.stubEnv("INTERNAL_SECRET", SECRET);
    expect(isAuthorised(post({}))).toBe(false);
  });

  it("refuses the wrong secret", () => {
    vi.stubEnv("INTERNAL_SECRET", SECRET);
    expect(isAuthorised(post({ Authorization: "Bearer not-the-secret" }))).toBe(false);
  });

  it("refuses a secret that is merely a prefix of the real one", () => {
    vi.stubEnv("INTERNAL_SECRET", SECRET);
    expect(isAuthorised(post({ Authorization: `Bearer ${SECRET.slice(0, -1)}` }))).toBe(false);
  });

  it("refuses an Authorization header that is not a Bearer token", () => {
    vi.stubEnv("INTERNAL_SECRET", SECRET);
    expect(isAuthorised(post({ Authorization: SECRET }))).toBe(false);
  });

  it("refuses everything when INTERNAL_SECRET is unset", () => {
    // A blank secret must never mean "no gate". Same reasoning
    // app/api/google/start/route.ts gives for refusing to start a handshake it
    // cannot sign.
    vi.stubEnv("INTERNAL_SECRET", "");
    expect(isAuthorised(post({ Authorization: "Bearer " }))).toBe(false);
    expect(isAuthorised(post({ "X-Callzie-Secret": "" }))).toBe(false);
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/tools/auth.test.ts`
Expected: FAIL — cannot resolve `@/lib/tools/auth`.

- [x] **Step 3: Implement it**

`lib/tools/auth.ts`:

```ts
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The gate on all four Tool endpoints (issue #10, acceptance criterion 1).
 *
 * These routes are listed as public in `proxy.ts`, which means only that a Clerk
 * session cookie is not the gate. This is — and it is stricter, because Callzie
 * is open signup (SPEC.md §14 rule 9), so a cookie would let any account that
 * exists write to any Appointment.
 *
 * **Two headers are accepted.** `scripts/create-agent.ts` bakes
 * `Authorization: Bearer ${INTERNAL_SECRET}` into every Tool at creation time,
 * but docs/verification.md A12 records it as UNVERIFIED whether Retell forwards
 * that header unmodified, and names `X-Callzie-Secret` as the fallback.
 * Discovering it was stripped means a live call where every Tool 401s, and a
 * re-provisioning of four Agents to find out. Accepting both costs six lines.
 */

/** The fallback header from docs/verification.md A12. Lower-case: Headers is case-insensitive but this is also the key we document. */
export const SECRET_HEADER = "x-callzie-secret";

/** The credential this request presents, from either header, or null. */
function presented(request: Request): string | null {
  const custom = request.headers.get(SECRET_HEADER);
  if (custom !== null && custom !== "") return custom;

  const authorization = request.headers.get("authorization");
  if (authorization === null) return null;

  // Case-insensitive on the scheme: RFC 7235 says the scheme token is, and a
  // proxy that rewrites "Bearer" to "bearer" is not a request to refuse.
  const match = /^Bearer[ ]+(.+)$/i.exec(authorization.trim());
  return match ? match[1] : null;
}

/*
  Hashed before comparing, and this is not belt-and-braces.

  `timingSafeEqual` throws when the two buffers differ in length — so comparing
  raw secrets would turn "wrong length" into an exception and "right length,
  wrong value" into a false, which leaks the length of the real secret to anyone
  who can tell a 500 from a 401. SHA-256 makes every comparison 32 bytes against
  32 bytes, so the only thing observable is whether it matched.
*/
const digest = (value: string) =>
  createHash("sha256").update(value, "utf8").digest();

export function isAuthorised(
  request: Request,
  // Injected rather than read, so tests can describe a deployment without
  // mutating process.env — the same shape lib/settings/env-status.ts uses.
  secret: string | undefined = process.env.INTERNAL_SECRET,
): boolean {
  // An unconfigured deployment refuses everything. A blank secret that matched
  // a blank header would be an open endpoint that looks configured.
  if (!secret || secret.trim() === "") return false;

  const supplied = presented(request);
  if (supplied === null || supplied.trim() === "") return false;

  return timingSafeEqual(digest(supplied), digest(secret));
}
```

- [x] **Step 4: Run it to verify it passes**

Run: `npx vitest run lib/tools/auth.test.ts`
Expected: PASS, 7 tests.

- [x] **Step 5: Commit**

```bash
git add lib/tools/auth.ts lib/tools/auth.test.ts
git commit -m "Gate the Tool endpoints on the internal secret, from either header"
```

---

### Task 5: The test seed helper

Six test files need the same fixture: a User, a Business with Business Hours, a Service, an Appointment, and a `calls` row carrying a `retell_call_id`. Writing that six times is six chances to seed something subtly different.

**Files:**
- Create: `lib/tools/testing.ts`

- [x] **Step 1: Write it**

`lib/tools/testing.ts`:

```ts
import { eq } from "drizzle-orm";

import { provisionUser } from "@/lib/auth/provision-user";
import { db, schema } from "@/lib/db";

/**
 * Seed and tear down the fixture every Tool endpoint test needs.
 *
 * **Test-only.** Nothing under `app/` may import this. It lives in `lib/tools/`
 * rather than a top-level test directory so it sits beside the code it seeds
 * for, and it is not named `*.test.ts` because Vitest would try to run it.
 *
 * The shape it builds is exactly what issue #11 will leave behind when a Web
 * Call starts: a `calls` row with a `retell_call_id`, pointing at an Appointment
 * that belongs to a Business with Hours and a Service. #10 only ever reads it.
 */

/** Monday to Friday, 09:00-17:00. Weekday 0 is Sunday, matching `business_hours`. */
export const WEEKDAY_HOURS = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  opensAt: "09:00",
  closesAt: "17:00",
}));

export type ToolTestSeed = {
  userId: string;
  businessId: string;
  serviceId: string;
  appointmentId: string;
  /** The `calls.id` a `tool_invocations` row points at. */
  callId: string;
  /** What Retell puts in `call.call_id`. */
  retellCallId: string;
};

export type SeedOptions = {
  /** Unique per test file, so two files cannot delete each other's fixture. */
  clerkId: string;
  timezone?: string;
  durationMinutes?: number;
  hours?: { weekday: number; opensAt: string; closesAt: string }[];
  /** Where the Appointment starts before anything reschedules it. */
  appointmentStartsAt: Date;
};

export async function seedToolTest({
  clerkId,
  timezone = "Asia/Kolkata",
  durationMinutes = 60,
  hours = WEEKDAY_HOURS,
  appointmentStartsAt,
}: SeedOptions): Promise<ToolTestSeed> {
  const user = await provisionUser(clerkId, `${clerkId}@example.com`);

  const [business] = await db
    .insert(schema.businesses)
    .values({
      userId: user.id,
      name: "Tool Test Salon",
      businessType: "salon",
      timezone,
    })
    .returning();

  await db.insert(schema.businessHours).values(
    hours.map((h) => ({ businessId: business.id, ...h })),
  );

  const [service] = await db
    .insert(schema.services)
    .values({ businessId: business.id, name: "Haircut", durationMinutes })
    .returning();

  const [appointment] = await db
    .insert(schema.appointments)
    .values({
      businessId: business.id,
      serviceId: service.id,
      name: "Priya Sharma",
      phoneE164: "+919876543210",
      startsAt: appointmentStartsAt,
      endsAt: new Date(appointmentStartsAt.getTime() + durationMinutes * 60_000),
      status: "calling",
    })
    .returning();

  const retellCallId = `call_${clerkId}`;
  const [call] = await db
    .insert(schema.calls)
    .values({
      appointmentId: appointment.id,
      retellCallId,
      callType: "web",
      status: "in_progress",
    })
    .returning();

  return {
    userId: user.id,
    businessId: business.id,
    serviceId: service.id,
    appointmentId: appointment.id,
    callId: call.id,
    retellCallId,
  };
}

/**
 * Delete everything `seedToolTest` wrote, in foreign-key order.
 *
 * Safe to call before seeding as well as after — which is what makes a test file
 * recover from a previous run that died halfway.
 */
export async function cleanupToolTest(clerkId: string): Promise<void> {
  const user = await db.query.users.findFirst({
    where: eq(schema.users.clerkId, clerkId),
  });
  if (!user) return;

  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.userId, user.id),
  });

  if (business) {
    const appointments = await db
      .select({ id: schema.appointments.id })
      .from(schema.appointments)
      .where(eq(schema.appointments.businessId, business.id));

    for (const appointment of appointments) {
      const calls = await db
        .select({ id: schema.calls.id })
        .from(schema.calls)
        .where(eq(schema.calls.appointmentId, appointment.id));

      for (const call of calls) {
        await db
          .delete(schema.toolInvocations)
          .where(eq(schema.toolInvocations.callId, call.id));
      }

      await db.delete(schema.calls).where(eq(schema.calls.appointmentId, appointment.id));
    }

    await db
      .delete(schema.appointments)
      .where(eq(schema.appointments.businessId, business.id));
    await db.delete(schema.services).where(eq(schema.services.businessId, business.id));
    await db
      .delete(schema.businessHours)
      .where(eq(schema.businessHours.businessId, business.id));
    await db.delete(schema.businesses).where(eq(schema.businesses.id, business.id));
  }

  await db.delete(schema.users).where(eq(schema.users.clerkId, clerkId));
}
```

- [x] **Step 2: Commit**

No test of its own — it is exercised by every task after this, and a helper with its own test suite is a helper that has become a feature.

```bash
git add lib/tools/testing.ts
git commit -m "Seed the Business, Appointment and Call every Tool test needs"
```

---

### Task 6: Parsing the request and resolving who it is about

**Files:**
- Create: `lib/tools/request.ts`
- Test: `lib/tools/request.test.ts`

- [x] **Step 1: Write the failing test**

`lib/tools/request.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";
import { parseToolRequest, resolveToolContext } from "@/lib/tools/request";

const CLERK_ID = "user_test_tools_request";
const APPOINTMENT_STARTS_AT = new Date("2026-08-17T03:30:00.000Z");

let seed: ToolTestSeed;

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({ clerkId: CLERK_ID, appointmentStartsAt: APPOINTMENT_STARTS_AT });
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
});

describe("parseToolRequest", () => {
  it("reads the envelope docs/verification.md A12 records", () => {
    expect(
      parseToolRequest({
        name: "book_slot",
        call: { call_id: "call_abc", transcript: "Agent: hello" },
        args: { slot_start: "2026-08-20T08:30:00.000Z" },
      }),
    ).toEqual({
      name: "book_slot",
      callId: "call_abc",
      args: { slot_start: "2026-08-20T08:30:00.000Z" },
    });
  });

  it("treats a missing args object as no arguments", () => {
    // confirm_appointment and cancel_appointment declare an empty schema
    // (lib/retell/tools.ts), and an empty schema may arrive as no key at all.
    expect(parseToolRequest({ name: "confirm_appointment", call: { call_id: "call_abc" } }))
      .toEqual({ name: "confirm_appointment", callId: "call_abc", args: {} });
  });

  it.each([
    ["not an object", "nope"],
    ["null", null],
    ["no name", { call: { call_id: "call_abc" }, args: {} }],
    ["no call", { name: "book_slot", args: {} }],
    ["no call_id", { name: "book_slot", call: {}, args: {} }],
    ["a numeric call_id", { name: "book_slot", call: { call_id: 7 }, args: {} }],
    ["an array for args", { name: "book_slot", call: { call_id: "c" }, args: [] }],
  ])("refuses a body with %s", (_label, body) => {
    expect(parseToolRequest(body)).toBeNull();
  });
});

describe("resolveToolContext", () => {
  it("resolves the Call to its Appointment, Business and Service", async () => {
    const context = await resolveToolContext(seed.retellCallId);

    expect(context).not.toBeNull();
    expect(context!.callId).toBe(seed.callId);
    expect(context!.businessId).toBe(seed.businessId);
    expect(context!.serviceId).toBe(seed.serviceId);
    expect(context!.timezone).toBe("Asia/Kolkata");
    expect(context!.durationMinutes).toBe(60);
    expect(context!.appointment.id).toBe(seed.appointmentId);
    expect(context!.appointment.startsAt).toEqual(APPOINTMENT_STARTS_AT);
  });

  it("returns null for a call_id nothing knows about", async () => {
    // A model cannot invent its way into a row: identity comes from `call`, and
    // an unknown one resolves to nothing rather than to a default.
    expect(await resolveToolContext("call_does_not_exist")).toBeNull();
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/tools/request.test.ts`
Expected: FAIL — cannot resolve `@/lib/tools/request`.

- [x] **Step 3: Implement it**

`lib/tools/request.ts`:

```ts
import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/**
 * Who a Tool call is about — resolved from the `call` object Retell sends,
 * never from anything the model wrote.
 *
 * `lib/retell/tools.ts` refuses to put an identifier in any Tool's argument
 * schema and gives the reason: if the Appointment id were an argument, the model
 * would be choosing which row it writes to, and one hallucinated uuid becomes a
 * cross-tenant write. This module is the other half of that promise. Everything
 * downstream is scoped by the `businessId` that comes out of here.
 *
 * The chain, all from one string:
 *
 *   call.call_id -> calls.retell_call_id -> calls.appointment_id
 *                -> appointments -> businesses.timezone, services.duration_minutes
 */

/** What Retell posts. Only the two fields Callzie reads are described. */
export type ToolRequestBody = {
  name: string;
  /** `call.call_id` — Retell's id, not the `calls.id` primary key. */
  callId: string;
  args: Record<string, unknown>;
};

export type ToolContext = {
  /** `calls.id`. This is what a `tool_invocations` row points at. */
  callId: string;
  appointment: typeof schema.appointments.$inferSelect;
  businessId: string;
  /** IANA zone. Everything Maya says aloud is rendered in it. */
  timezone: string;
  serviceId: string;
  /** Also the Slot size. */
  durationMinutes: number;
};

/**
 * Reads Retell's envelope, or returns null.
 *
 * Null rather than a thrown error: the caller turns it into a 400, and a
 * malformed body is an ordinary thing to receive on a public URL, not an
 * exceptional one.
 */
export function parseToolRequest(body: unknown): ToolRequestBody | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;

  const { name, call, args } = body as {
    name?: unknown;
    call?: unknown;
    args?: unknown;
  };

  if (typeof name !== "string" || name === "") return null;
  if (typeof call !== "object" || call === null) return null;

  const callId = (call as { call_id?: unknown }).call_id;
  if (typeof callId !== "string" || callId === "") return null;

  /*
    A Tool with an empty parameter schema — confirm_appointment and
    cancel_appointment — may arrive with no `args` key at all. That is a valid
    call with no arguments, not a malformed body, so it becomes {} rather than a
    400. An array is refused: `args` is a JSON object in every documented shape,
    and `typeof [] === "object"` would otherwise let one through.
  */
  const suppliedArgs = args ?? {};
  if (typeof suppliedArgs !== "object" || Array.isArray(suppliedArgs)) return null;

  return { name, callId, args: suppliedArgs as Record<string, unknown> };
}

/** Everything the four handlers need, or null if this Call is unknown. */
export async function resolveToolContext(
  retellCallId: string,
): Promise<ToolContext | null> {
  const call = await db.query.calls.findFirst({
    where: eq(schema.calls.retellCallId, retellCallId),
    columns: { id: true, appointmentId: true },
  });
  if (!call) return null;

  const appointment = await db.query.appointments.findFirst({
    where: eq(schema.appointments.id, call.appointmentId),
  });
  if (!appointment) return null;

  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.id, appointment.businessId),
    columns: { id: true, timezone: true },
  });
  if (!business) return null;

  const service = await db.query.services.findFirst({
    // Scoped to the Business, matching lib/availability/schedule.ts: a Service
    // from another account must not resolve, or one Business could be sized by
    // another's duration.
    where: and(
      eq(schema.services.id, appointment.serviceId),
      eq(schema.services.businessId, appointment.businessId),
    ),
    columns: { id: true, durationMinutes: true },
  });
  if (!service) return null;

  return {
    callId: call.id,
    appointment,
    businessId: business.id,
    timezone: business.timezone,
    serviceId: service.id,
    durationMinutes: service.durationMinutes,
  };
}
```

- [x] **Step 4: Run it to verify it passes**

Run: `npx vitest run lib/tools/request.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add lib/tools/request.ts lib/tools/request.test.ts
git commit -m "Resolve a Tool call's identity from Retell's call object, never from args"
```

---

### Task 7: One transaction per Tool call

**Files:**
- Create: `lib/tools/run.ts`
- Test: `lib/tools/run.test.ts`

- [x] **Step 1: Write the failing test**

`lib/tools/run.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import { resolveToolContext, type ToolContext } from "@/lib/tools/request";
import { runTool } from "@/lib/tools/run";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

/*
  Acceptance criteria 5 and 6: every invocation is recorded with its arguments,
  result and success flag, and latency is measured.
*/

const CLERK_ID = "user_test_tools_run";
const APPOINTMENT_STARTS_AT = new Date("2026-08-17T03:30:00.000Z");

let seed: ToolTestSeed;
let context: ToolContext;

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({ clerkId: CLERK_ID, appointmentStartsAt: APPOINTMENT_STARTS_AT });
  context = (await resolveToolContext(seed.retellCallId))!;
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
});

function invocations() {
  return db
    .select()
    .from(schema.toolInvocations)
    .where(eq(schema.toolInvocations.callId, seed.callId));
}

describe("runTool", () => {
  it("records the arguments, the result and the success flag", async () => {
    const result = await runTool({
      name: "check_availability",
      args: { preferred_time: "Thursday afternoon" },
      context,
      handler: async () => ({ succeeded: true, result: { ok: true, slots: [] } }),
    });

    expect(result).toEqual({ ok: true, slots: [] });

    const [row] = await invocations();
    expect(row.toolName).toBe("check_availability");
    expect(row.arguments).toEqual({ preferred_time: "Thursday afternoon" });
    expect(row.result).toEqual({ ok: true, slots: [] });
    expect(row.succeeded).toBe(true);
  });

  it("measures latency", async () => {
    await runTool({
      name: "confirm_appointment",
      args: {},
      context,
      handler: async () => ({ succeeded: true, result: { ok: true } }),
    });

    const [row] = await invocations();
    // A slow Tool is dead air on a live call (issue #10), so the number has to
    // exist before anyone can argue about what it should be.
    expect(row.latencyMs).toBeTypeOf("number");
    expect(row.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("records a refusal, not just a success", async () => {
    await runTool({
      name: "book_slot",
      args: { slot_start: "2026-08-20T08:30:00.000Z" },
      context,
      handler: async () => ({ succeeded: false, result: { ok: false, reason: "not_offered" } }),
    });

    const [row] = await invocations();
    expect(row.succeeded).toBe(false);
    expect(row.result).toEqual({ ok: false, reason: "not_offered" });
  });

  it("records a handler that threw, and does not rethrow", async () => {
    // SPEC.md §3 rule 7: Maya must never claim a booking succeeded when the Tool
    // failed. A thrown error reaching Retell as a 500 tells her nothing; a body
    // saying ok:false tells her what to say.
    const result = await runTool({
      name: "book_slot",
      args: {},
      context,
      handler: async () => {
        throw new Error("the database went away");
      },
    });

    expect(result).toEqual({ ok: false, reason: "error" });

    const [row] = await invocations();
    expect(row.succeeded).toBe(false);
  });

  it("rolls back the handler's writes when it throws", async () => {
    await runTool({
      name: "cancel_appointment",
      args: {},
      context,
      handler: async ({ tx }) => {
        await tx
          .update(schema.appointments)
          .set({ status: "cancelled" })
          .where(eq(schema.appointments.id, seed.appointmentId));
        throw new Error("changed my mind");
      },
    });

    const appointment = await db.query.appointments.findFirst({
      where: eq(schema.appointments.id, seed.appointmentId),
    });
    // The write is gone, but the record of the attempt is not — it is written on
    // a fresh connection, outside the rolled-back transaction.
    expect(appointment!.status).toBe("calling");
    expect(await invocations()).toHaveLength(1);
  });

  it("refuses a second successful book_slot in the same Call", async () => {
    const booking = () =>
      runTool({
        name: "book_slot",
        args: { slot_start: "2026-08-20T08:30:00.000Z" },
        context,
        handler: async ({ tx }) => {
          await tx
            .update(schema.appointments)
            .set({ status: "rescheduled" })
            .where(eq(schema.appointments.id, seed.appointmentId));
          return { succeeded: true, result: { ok: true } };
        },
      });

    expect(await booking()).toEqual({ ok: true });
    expect(await booking()).toEqual({ ok: false, reason: "already_booked" });

    const rows = await invocations();
    expect(rows.filter((r) => r.succeeded)).toHaveLength(1);
    expect(rows.filter((r) => !r.succeeded)).toHaveLength(1);
  });

  it("still allows further check_availability calls after a booking", async () => {
    await runTool({
      name: "book_slot",
      args: {},
      context,
      handler: async () => ({ succeeded: true, result: { ok: true } }),
    });

    for (let i = 0; i < 3; i++) {
      expect(
        await runTool({
          name: "check_availability",
          args: {},
          context,
          handler: async () => ({ succeeded: true, result: { ok: true, slots: [] } }),
        }),
      ).toEqual({ ok: true, slots: [] });
    }

    const checks = (await invocations()).filter((r) => r.toolName === "check_availability");
    expect(checks).toHaveLength(3);
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/tools/run.test.ts`
Expected: FAIL — cannot resolve `@/lib/tools/run`.

- [x] **Step 3: Implement it**

`lib/tools/run.ts`:

```ts
import { db, schema } from "@/lib/db";
import type { ToolName } from "@/lib/db/schema";
import type { ToolContext } from "@/lib/tools/request";

/**
 * Every Tool call runs inside one transaction that also writes its own
 * `tool_invocations` row.
 *
 * That single sentence is the mechanism the whole ticket rests on. Follow a
 * second `book_slot` in the same Call:
 *
 *   1. Transaction opens.
 *   2. The Appointment is moved to the new Slot.
 *   3. The record row is inserted — and `tool_invocations_one_booking_per_call`
 *      refuses it, because this Call already committed a Reschedule.
 *   4. The whole transaction rolls back. **Step 2 is undone with step 3.**
 *
 * So "exactly one Reschedule per Call" (CONTEXT.md) is enforced by Postgres, and
 * there is no ordering of the two writes that could leave them disagreeing.
 *
 * The same wrapper serves all four Tools. For the other three the transaction is
 * doing nothing clever, and that is fine — one shape for all four is worth more
 * than saving a BEGIN on three of them.
 *
 * `tool_invocations` is the authoritative record of what happened (SPEC.md §9
 * step 3): Extraction never overwrites it. A booking that happened without a
 * record is worse than one that failed, because the Call detail screen (#16)
 * would show a Call in which Maya apparently did nothing.
 */

/**
 * Drizzle's transaction handle, derived from `db` rather than imported.
 * `PgTransaction`'s type parameters have to match the schema exactly, and
 * spelling them out by hand is a thing that silently drifts.
 */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** What a handler hands back: the JSON Maya reads, and whether it worked. */
export type ToolOutcome = {
  /** Written to `tool_invocations.succeeded`, and what the one-booking index keys on. */
  succeeded: boolean;
  /** The response body, verbatim. */
  result: unknown;
};

export type ToolHandlerInput = {
  tx: Tx;
  context: ToolContext;
  args: Record<string, unknown>;
  /** Injected rather than read, so tests can pin the clock. */
  now: Date;
};

export type ToolHandler = (input: ToolHandlerInput) => Promise<ToolOutcome>;

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = "23505";
const ONE_BOOKING_INDEX = "tool_invocations_one_booking_per_call";

export type RunToolInput = {
  name: ToolName;
  args: Record<string, unknown>;
  context: ToolContext;
  handler: ToolHandler;
  now?: Date;
};

export async function runTool({
  name,
  args,
  context,
  handler,
  now = new Date(),
}: RunToolInput): Promise<unknown> {
  const startedAt = performance.now();

  try {
    return await db.transaction(async (tx) => {
      const outcome = await handler({ tx, context, args, now });

      await tx.insert(schema.toolInvocations).values({
        callId: context.callId,
        toolName: name,
        arguments: args,
        result: outcome.result,
        succeeded: outcome.succeeded,
        latencyMs: elapsedMs(startedAt),
      });

      return outcome.result;
    });
  } catch (error) {
    /*
      This is the only code that inserts into `tool_invocations`, so it is the
      only code positioned to recognise that table's constraints. Knowing about
      book_slot here is a small impurity paid for by that.
    */
    const result = isSecondBooking(error)
      ? { ok: false, reason: "already_booked" }
      : { ok: false, reason: "error" };

    await recordFailure({ name, args, context, result, startedAt });
    return result;
  }
}

/**
 * Write the record of a failure on a fresh connection.
 *
 * Outside the rolled-back transaction, deliberately: writing it inside would
 * roll the record back along with the failure it describes, and the Call would
 * look like one where Maya never invoked anything.
 *
 * `succeeded: false` also keeps this row clear of the one-booking index, which
 * is what lets SPEC.md §8's retry and any number of lost races be recorded.
 */
async function recordFailure({
  name,
  args,
  context,
  result,
  startedAt,
}: {
  name: ToolName;
  args: Record<string, unknown>;
  context: ToolContext;
  result: unknown;
  startedAt: number;
}): Promise<void> {
  try {
    await db.insert(schema.toolInvocations).values({
      callId: context.callId,
      toolName: name,
      arguments: args,
      result,
      succeeded: false,
      latencyMs: elapsedMs(startedAt),
    });
  } catch (error) {
    // A failure to record a failure must not become the response. Maya is mid
    // sentence; she needs a body to read, not a 500.
    console.error(`Could not record a failed ${name} for call ${context.callId}`, error);
  }
}

/** Whether this error is the one-booking index refusing a second Reschedule. */
function isSecondBooking(error: unknown): boolean {
  /*
    The `cause` chain has to be walked. Drizzle does not hand back the error `pg`
    raised: it wraps it in a DrizzleQueryError carrying the SQL and the
    parameters, and puts the original on `cause` — the same trap
    lib/availability/slot-taken.ts documents at length. Three levels is plenty
    for one wrapper, and a fixed limit means a cyclic `cause` cannot spin here.
  */
  for (let current = error, depth = 0; depth < 3; depth++) {
    if (typeof current !== "object" || current === null) return false;
    const { code, constraint } = current as { code?: string; constraint?: string };
    // Both, not just the code: a future unique index elsewhere must not read as
    // "you already booked".
    if (code === UNIQUE_VIOLATION && constraint === ONE_BOOKING_INDEX) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/*
  Whole milliseconds. `performance.now()` returns fractions, and `latency_ms` is
  an integer column — an unrounded value would be silently truncated by pg
  rather than rejected.
*/
function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}
```

- [x] **Step 4: Run it to verify it passes**

Run: `npx vitest run lib/tools/run.test.ts`
Expected: PASS, 8 tests.

- [x] **Step 5: Commit**

```bash
git add lib/tools/run.ts lib/tools/run.test.ts
git commit -m "Run every Tool in one transaction that also writes its own record"
```

---

### Task 8: Moving an Appointment

**Files:**
- Create: `lib/appointments/reschedule.ts`
- Test: `lib/appointments/reschedule.test.ts`

- [x] **Step 1: Write the failing test**

`lib/appointments/reschedule.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { rescheduleAppointment } from "@/lib/appointments/reschedule";
import { db, schema } from "@/lib/db";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

const CLERK_ID = "user_test_appointments_reschedule";

// 09:00 Asia/Kolkata on Monday 2026-08-17, 60-minute Service.
const ORIGINAL = new Date("2026-08-17T03:30:00.000Z");
// 11:00 the same day.
const TARGET = new Date("2026-08-17T05:30:00.000Z");

let seed: ToolTestSeed;

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({ clerkId: CLERK_ID, appointmentStartsAt: ORIGINAL });
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
});

function appointment() {
  return db.query.appointments.findFirst({
    where: eq(schema.appointments.id, seed.appointmentId),
  });
}

describe("rescheduleAppointment", () => {
  it("moves the Appointment and marks it rescheduled", async () => {
    const result = await db.transaction((tx) =>
      rescheduleAppointment({
        tx,
        appointmentId: seed.appointmentId,
        durationMinutes: 60,
        startsAt: TARGET,
      }),
    );

    expect(result.ok).toBe(true);

    const moved = await appointment();
    expect(moved!.startsAt).toEqual(TARGET);
    // Derived here, never accepted from a caller: ends_at is half of what the
    // exclusion constraint compares.
    expect(moved!.endsAt).toEqual(new Date("2026-08-17T06:30:00.000Z"));
    expect(moved!.status).toBe("rescheduled");
  });

  it("reports a taken Slot as a value, not an exception", async () => {
    // Maya answers "that time just went" by offering another one (SPEC.md §8).
    // An exception would surface as a Tool failure instead.
    await db.insert(schema.appointments).values({
      businessId: seed.businessId,
      serviceId: seed.serviceId,
      name: "Someone Else",
      phoneE164: "+919876500000",
      startsAt: TARGET,
      endsAt: new Date("2026-08-17T06:30:00.000Z"),
      status: "confirmed",
    });

    const result = await db.transaction((tx) =>
      rescheduleAppointment({
        tx,
        appointmentId: seed.appointmentId,
        durationMinutes: 60,
        startsAt: TARGET,
      }),
    );

    expect(result).toEqual({ ok: false, reason: "slot_taken" });
  });

  it("leaves the Appointment on its original Slot when it loses", async () => {
    await db.insert(schema.appointments).values({
      businessId: seed.businessId,
      serviceId: seed.serviceId,
      name: "Someone Else",
      phoneE164: "+919876500000",
      startsAt: TARGET,
      endsAt: new Date("2026-08-17T06:30:00.000Z"),
      status: "confirmed",
    });

    await db.transaction((tx) =>
      rescheduleAppointment({
        tx,
        appointmentId: seed.appointmentId,
        durationMinutes: 60,
        startsAt: TARGET,
      }),
    );

    // SPEC.md §8 step 3: the Appointment keeps its original Slot.
    const unchanged = await appointment();
    expect(unchanged!.startsAt).toEqual(ORIGINAL);
    expect(unchanged!.status).toBe("calling");
  });

  it("leaves the transaction usable after a loss", async () => {
    /*
      The savepoint, asserted. Postgres aborts a whole transaction the moment a
      statement fails, so without one, everything after the losing UPDATE —
      SPEC.md §8's retry, the book_failed write, the tool_invocations row — would
      fail with "current transaction is aborted". This test is what catches its
      removal.
    */
    await db.insert(schema.appointments).values({
      businessId: seed.businessId,
      serviceId: seed.serviceId,
      name: "Someone Else",
      phoneE164: "+919876500000",
      startsAt: TARGET,
      endsAt: new Date("2026-08-17T06:30:00.000Z"),
      status: "confirmed",
    });

    const stillWorks = await db.transaction(async (tx) => {
      await rescheduleAppointment({
        tx,
        appointmentId: seed.appointmentId,
        durationMinutes: 60,
        startsAt: TARGET,
      });

      // Would throw "current transaction is aborted" without the savepoint.
      await tx
        .update(schema.appointments)
        .set({ needsAttentionReason: "book_failed" })
        .where(eq(schema.appointments.id, seed.appointmentId));

      return true;
    });

    expect(stillWorks).toBe(true);
    expect((await appointment())!.needsAttentionReason).toBe("book_failed");
  });

  it("takes a Slot freed by a cancelled Appointment", async () => {
    await db.insert(schema.appointments).values({
      businessId: seed.businessId,
      serviceId: seed.serviceId,
      name: "Cancelled Person",
      phoneE164: "+919876500001",
      startsAt: TARGET,
      endsAt: new Date("2026-08-17T06:30:00.000Z"),
      status: "cancelled",
    });

    const result = await db.transaction((tx) =>
      rescheduleAppointment({
        tx,
        appointmentId: seed.appointmentId,
        durationMinutes: 60,
        startsAt: TARGET,
      }),
    );

    expect(result.ok).toBe(true);
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/appointments/reschedule.test.ts`
Expected: FAIL — cannot resolve `@/lib/appointments/reschedule`.

- [x] **Step 3: Implement it**

`lib/appointments/reschedule.ts`:

```ts
import { eq } from "drizzle-orm";

import { isSlotTaken } from "@/lib/availability/slot-taken";
import { schema } from "@/lib/db";
import type { Tx } from "@/lib/tools/run";

/**
 * Move an existing Appointment to another Slot — CONTEXT.md's **Reschedule**.
 *
 * Not `lib/availability/book.ts`, which inserts a new Appointment for the
 * quick-add card. A Reschedule moves the row the Call is already about, so the
 * person keeps one Appointment rather than acquiring a second.
 *
 * **An UPDATE is checked by `appointments_no_overlap` exactly as an INSERT is.**
 * An exclusion constraint tests the row's new range whichever statement produced
 * it, so the no-overlap guarantee needs nothing new here. Nothing in this
 * function asks whether the Slot is free first, and nothing should be added that
 * does: SPEC.md §5 permits three concurrent Calls, and three Agents running
 * check-then-write will find any gap between the read and the write.
 */

export type RescheduleResult =
  | { ok: true; startsAt: Date; endsAt: Date }
  | { ok: false; reason: "slot_taken" };

export type RescheduleInput = {
  /** The caller's transaction. The record of this write is committed with it. */
  tx: Tx;
  appointmentId: string;
  /** The Service's length, from the resolved context. */
  durationMinutes: number;
  startsAt: Date;
};

export async function rescheduleAppointment({
  tx,
  appointmentId,
  durationMinutes,
  startsAt,
}: RescheduleInput): Promise<RescheduleResult> {
  /*
    Derived here, never accepted from the caller — the same rule
    lib/availability/book.ts states, for the same reason: `ends_at` is half of
    what the exclusion constraint compares, so a caller able to supply it could
    defeat the constraint with a one-minute end time.

    Absolute milliseconds, not a wall-clock addition: an Appointment occupies
    real time, so a 90-minute Colour across a spring-forward still takes 90
    minutes even though the clock advances 150.
  */
  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);

  try {
    /*
      A nested transaction, which Drizzle issues as a SAVEPOINT — a marker inside
      a transaction you can roll back to without losing the transaction.

      This is not tidiness. Postgres aborts the whole transaction the instant a
      statement fails, so after the constraint rejects this UPDATE, every later
      statement in the caller's transaction would fail with "current transaction
      is aborted": SPEC.md §8's silent retry, the `book_failed` write, and the
      `tool_invocations` row that is the authoritative record of the attempt.
      Rolling back to a savepoint instead leaves the caller's transaction alive.
    */
    return await tx.transaction(async (savepoint) => {
      const [moved] = await savepoint
        .update(schema.appointments)
        .set({ startsAt, endsAt, status: "rescheduled" })
        .where(eq(schema.appointments.id, appointmentId))
        .returning();

      if (!moved) throw new Error(`No Appointment ${appointmentId}`);

      return { ok: true as const, startsAt, endsAt };
    });
  } catch (error) {
    if (isSlotTaken(error)) return { ok: false, reason: "slot_taken" };
    // A dropped connection is not a busy Slot. Telling them apart is what lets
    // SPEC.md §3 rule 7 hold: Maya must never claim a booking succeeded when the
    // Tool failed, and she must be told which of the two happened.
    throw error;
  }
}
```

- [x] **Step 4: Run it to verify it passes**

Run: `npx vitest run lib/appointments/reschedule.test.ts`
Expected: PASS, 5 tests.

- [x] **Step 5: Commit**

```bash
git add lib/appointments/reschedule.ts lib/appointments/reschedule.test.ts
git commit -m "Move an Appointment to another Slot, on a savepoint so a loss is survivable"
```

---

### Task 9: What this Call was actually offered

**Files:**
- Create: `lib/tools/offers.ts`
- Test: `lib/tools/offers.test.ts`

- [x] **Step 1: Write the failing test**

`lib/tools/offers.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import { offeredSlotsInCall } from "@/lib/tools/offers";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

const CLERK_ID = "user_test_tools_offers";
const APPOINTMENT_STARTS_AT = new Date("2026-08-17T03:30:00.000Z");

const NINE_AM = "2026-08-20T03:30:00.000Z";
const TWO_PM = "2026-08-20T08:30:00.000Z";

let seed: ToolTestSeed;

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({ clerkId: CLERK_ID, appointmentStartsAt: APPOINTMENT_STARTS_AT });
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
});

async function recordCheck(slots: string[], succeeded = true) {
  await db.insert(schema.toolInvocations).values({
    callId: seed.callId,
    toolName: "check_availability",
    arguments: {},
    result: {
      ok: true,
      slots: slots.map((slot_start) => ({ slot_start, time: "whenever" })),
    },
    succeeded,
    latencyMs: 4,
  });
}

describe("offeredSlotsInCall", () => {
  it("is empty before anything has been offered", async () => {
    const offered = await db.transaction((tx) => offeredSlotsInCall(tx, seed.callId));
    expect(offered.size).toBe(0);
  });

  it("collects every Slot from every check in the Call", async () => {
    // Offers are unlimited (SPEC.md §7). A time offered in turn two is still
    // bookable in turn nine, because people say "actually, the first one".
    await recordCheck([NINE_AM]);
    await recordCheck([TWO_PM]);

    const offered = await db.transaction((tx) => offeredSlotsInCall(tx, seed.callId));
    expect([...offered].sort()).toEqual([NINE_AM, TWO_PM].sort());
  });

  it("ignores checks that failed", async () => {
    await recordCheck([NINE_AM], false);
    const offered = await db.transaction((tx) => offeredSlotsInCall(tx, seed.callId));
    expect(offered.size).toBe(0);
  });

  it("ignores rows from other Tools", async () => {
    await db.insert(schema.toolInvocations).values({
      callId: seed.callId,
      toolName: "book_slot",
      arguments: { slot_start: NINE_AM },
      result: { ok: true },
      succeeded: true,
      latencyMs: 4,
    });

    const offered = await db.transaction((tx) => offeredSlotsInCall(tx, seed.callId));
    expect(offered.size).toBe(0);
  });

  it("survives a result that is not shaped like a list of Slots", async () => {
    // The column is jsonb. Anything could be in an old row, and this must not be
    // the thing that throws mid-call.
    await db.insert(schema.toolInvocations).values({
      callId: seed.callId,
      toolName: "check_availability",
      arguments: {},
      result: { ok: false, reason: "error" },
      succeeded: true,
      latencyMs: 4,
    });

    const offered = await db.transaction((tx) => offeredSlotsInCall(tx, seed.callId));
    expect(offered.size).toBe(0);
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/tools/offers.test.ts`
Expected: FAIL — cannot resolve `@/lib/tools/offers`.

- [x] **Step 3: Implement it**

`lib/tools/offers.ts`:

```ts
import { and, eq } from "drizzle-orm";

import { schema } from "@/lib/db";
import type { Tx } from "@/lib/tools/run";

/**
 * Every `slot_start` this Call has actually been offered.
 *
 * This is what turns "only ever offer times check_availability returned"
 * (SPEC.md §7's prompt) from a request into a rule. `lib/retell/tools.ts`
 * declares `slot_start` an opaque token the model copies rather than composes,
 * and this is the other half of that: the endpoint checks the token came from us.
 *
 * **Read back rather than cached.** The rows are already being written — issue
 * #10 requires every invocation to be recorded — so this costs one query on
 * `tool_invocations_call_id_idx`, an index that already exists. A cache would be
 * a second copy of the record, and a second copy can disagree with the first.
 *
 * Scoped to the Call, not to the last Offer. A time named in turn two stays
 * bookable in turn nine, because "actually, the first one you said" is a real
 * thing people say.
 */

/** One entry of `check_availability`'s response. */
export type OfferedSlot = {
  /** An ISO 8601 instant. The token `book_slot` echoes back. */
  slot_start: string;
  /** What Maya said out loud. Recorded so #16 can show it; not compared. */
  time: string;
};

export async function offeredSlotsInCall(
  tx: Tx,
  callId: string,
): Promise<Set<string>> {
  const rows = await tx
    .select({ result: schema.toolInvocations.result })
    .from(schema.toolInvocations)
    .where(
      and(
        eq(schema.toolInvocations.callId, callId),
        eq(schema.toolInvocations.toolName, "check_availability"),
        // A check that failed offered nothing, whatever is in its result.
        eq(schema.toolInvocations.succeeded, true),
      ),
    );

  const offered = new Set<string>();

  /*
    Defensive about the shape, deliberately. `result` is jsonb, so anything could
    be in a row written by an older version of this code — and the alternative to
    skipping an unrecognised row is throwing, mid-call, on data that is merely
    old.
  */
  for (const row of rows) {
    const slots = (row.result as { slots?: unknown } | null)?.slots;
    if (!Array.isArray(slots)) continue;

    for (const slot of slots) {
      const start = (slot as { slot_start?: unknown } | null)?.slot_start;
      if (typeof start === "string") offered.add(start);
    }
  }

  return offered;
}
```

- [x] **Step 4: Run it to verify it passes**

Run: `npx vitest run lib/tools/offers.test.ts`
Expected: PASS, 5 tests.

- [x] **Step 5: Commit**

```bash
git add lib/tools/offers.ts lib/tools/offers.test.ts
git commit -m "Read back which Slots a Call was offered, so book_slot can insist on one"
```

---

### Task 10: `check_availability`

**Files:**
- Create: `lib/tools/check-availability.ts`
- Test: `lib/tools/check-availability.test.ts`

- [x] **Step 1: Write the failing test**

`lib/tools/check-availability.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import { MAX_OFFERS, checkAvailability } from "@/lib/tools/check-availability";
import { resolveToolContext, type ToolContext } from "@/lib/tools/request";
import { runTool } from "@/lib/tools/run";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

/*
  Acceptance criterion 2: check_availability never returns a Slot outside
  Business Hours or in the past.
*/

const CLERK_ID = "user_test_tools_check_availability";

// The Appointment under discussion: 09:00 Asia/Kolkata, Monday 2026-08-17.
const APPOINTMENT_STARTS_AT = new Date("2026-08-17T03:30:00.000Z");
// "Now" is 08:00 Asia/Kolkata that Monday — an hour before the Business opens.
const NOW = new Date("2026-08-17T02:30:00.000Z");

let seed: ToolTestSeed;
let context: ToolContext;

async function offer(now = NOW) {
  return (await runTool({
    name: "check_availability",
    args: {},
    context,
    handler: checkAvailability,
    now,
  })) as { ok: boolean; slots: { slot_start: string; time: string }[] };
}

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
});

describe("checkAvailability", () => {
  beforeEach(async () => {
    await cleanupToolTest(CLERK_ID);
    seed = await seedToolTest({ clerkId: CLERK_ID, appointmentStartsAt: APPOINTMENT_STARTS_AT });
    context = (await resolveToolContext(seed.retellCallId))!;
  });

  it("returns at most three Slots", async () => {
    // SPEC.md §7: "up to 3 open Slots". More is not more helpful down a phone
    // line — nobody holds five times in their head.
    const result = await offer();
    expect(result.ok).toBe(true);
    expect(result.slots).toHaveLength(MAX_OFFERS);
  });

  it("gives each Slot a token and a spoken time", async () => {
    const [first] = (await offer()).slots;

    // 10:00 Asia/Kolkata: 09:00 is held by the Appointment this Call is about.
    expect(first.slot_start).toBe("2026-08-17T04:30:00.000Z");
    expect(first.time).toBe("Monday 17 August at 10:00 AM");
  });

  it("never offers the Slot the Appointment already holds", async () => {
    const starts = (await offer()).slots.map((s) => s.slot_start);
    expect(starts).not.toContain(APPOINTMENT_STARTS_AT.toISOString());
  });

  it("never offers a Slot in the past", async () => {
    // Midday Monday. Everything before it is gone.
    const noon = new Date("2026-08-17T06:30:00.000Z");
    for (const slot of (await offer(noon)).slots) {
      expect(new Date(slot.slot_start).getTime()).toBeGreaterThanOrEqual(noon.getTime());
    }
  });

  it("never offers a Slot outside Business Hours", async () => {
    // Every Slot must start at or after 09:00 and end by 17:00 local. With a
    // 60-minute Service that means a local hour from 09 to 16.
    for (const slot of (await offer()).slots) {
      const hour = new Date(slot.slot_start).getUTCHours() * 60
        + new Date(slot.slot_start).getUTCMinutes();
      // 03:30 UTC = 09:00 IST, 10:30 UTC = 16:00 IST.
      expect(hour).toBeGreaterThanOrEqual(3 * 60 + 30);
      expect(hour).toBeLessThanOrEqual(10 * 60 + 30);
    }
  });

  it("records preferred_time without acting on it", async () => {
    await runTool({
      name: "check_availability",
      args: { preferred_time: "Thursday afternoon" },
      context,
      handler: checkAvailability,
      now: NOW,
    });

    const [row] = await db.select().from(schema.toolInvocations);
    // Recorded so we can see the phrases people really use before writing a
    // parser for them. Deliberately not honoured yet — see the design doc.
    expect(row.arguments).toEqual({ preferred_time: "Thursday afternoon" });
  });
});

describe("checkAvailability with nothing open", () => {
  beforeEach(async () => {
    await cleanupToolTest(CLERK_ID);
    // A Business open only on Sunday, asked on a Monday, looking 14 days ahead
    // still finds Sundays — so close every day instead.
    seed = await seedToolTest({
      clerkId: CLERK_ID,
      appointmentStartsAt: APPOINTMENT_STARTS_AT,
      hours: [],
    });
    context = (await resolveToolContext(seed.retellCallId))!;
  });

  it("returns an empty list, not a failure", async () => {
    // A fully booked fortnight is something Maya should say, not something that
    // should read to her as a broken Tool.
    const result = await offer();
    expect(result).toEqual({ ok: true, slots: [] });

    const [row] = await db.select().from(schema.toolInvocations);
    expect(row.succeeded).toBe(true);
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/tools/check-availability.test.ts`
Expected: FAIL — cannot resolve `@/lib/tools/check-availability`.

- [x] **Step 3: Implement it**

`lib/tools/check-availability.ts`:

```ts
import { findAvailableSlots } from "@/lib/availability/find";
import { spokenTime } from "@/lib/tools/spoken-time";
import type { OfferedSlot } from "@/lib/tools/offers";
import type { ToolHandler } from "@/lib/tools/run";

/**
 * `check_availability` — up to three open Slots, in Business-local time
 * (SPEC.md §7).
 *
 * A local Postgres query and nothing else (ADR-0003): this runs mid-conversation
 * and a third-party network call here would be dead air while the caller waits.
 *
 * Nothing re-checks Business Hours or the past. `lib/availability/slots.ts`
 * already refuses to generate a Slot that runs past closing time or starts
 * before `now`, and a second check would be a second place to be wrong.
 */

/** SPEC.md §7's table says "up to 3". Nobody holds five times in their head. */
export const MAX_OFFERS = 3;

/**
 * How far ahead to look.
 *
 * Long enough that a Business open two days a week still has something to
 * offer; short enough that the query stays small. Named here rather than inlined
 * because a future `preferred_time` parser will want the same number.
 */
export const LOOKAHEAD_DAYS = 14;

const MS_PER_DAY = 86_400_000;

export type CheckAvailabilityResult = {
  ok: true;
  slots: OfferedSlot[];
};

export const checkAvailability: ToolHandler = async ({ context, now }) => {
  const slots = await findAvailableSlots({
    businessId: context.businessId,
    serviceId: context.serviceId,
    from: now,
    to: new Date(now.getTime() + LOOKAHEAD_DAYS * MS_PER_DAY),
    now,
  });

  const result: CheckAvailabilityResult = {
    ok: true,
    slots: slots.slice(0, MAX_OFFERS).map((slot) => ({
      /*
        ISO 8601, and the token book_slot must echo back. ISO rather than an
        opaque hash because #16 has to render it and a support conversation has
        to be able to read it — `lib/tools/offers.ts` is what makes it
        unforgeable, not its shape.
      */
      slot_start: slot.startsAt.toISOString(),
      // What Maya says. A different format for a different job — see
      // lib/tools/spoken-time.ts.
      time: spokenTime(slot.startsAt, context.timezone),
    })),
  };

  /*
    `succeeded: true` with an empty list. A fully booked fortnight is a fact
    about the Business, not a Tool failure — and recording it as a failure would
    make Maya say she will have someone call back (SPEC.md §8) about a question
    that was answered correctly.
  */
  return { succeeded: true, result };
};
```

- [x] **Step 4: Run it to verify it passes**

Run: `npx vitest run lib/tools/check-availability.test.ts`
Expected: PASS, 7 tests.

- [x] **Step 5: Commit**

```bash
git add lib/tools/check-availability.ts lib/tools/check-availability.test.ts
git commit -m "Offer up to three open Slots, with a token and a spoken time"
```

---

### Task 11: `book_slot`

**Files:**
- Create: `lib/tools/book-slot.ts`
- Test: `lib/tools/book-slot.test.ts`

- [x] **Step 1: Write the failing test**

`lib/tools/book-slot.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import { bookSlotTool } from "@/lib/tools/book-slot";
import { checkAvailability } from "@/lib/tools/check-availability";
import { resolveToolContext, type ToolContext } from "@/lib/tools/request";
import { runTool } from "@/lib/tools/run";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

/*
  Acceptance criteria 3 and 4: booking into an occupied Slot fails cleanly and
  does not corrupt the Appointment; a second book_slot in the same Call is
  refused while further check_availability calls are not.
*/

const CLERK_ID = "user_test_tools_book_slot";
const APPOINTMENT_STARTS_AT = new Date("2026-08-17T03:30:00.000Z");
const NOW = new Date("2026-08-17T02:30:00.000Z");

let seed: ToolTestSeed;
let context: ToolContext;

type BookResult = { ok: boolean; booked_time?: string; reason?: string };

async function check() {
  return (await runTool({
    name: "check_availability",
    args: {},
    context,
    handler: checkAvailability,
    now: NOW,
  })) as { ok: boolean; slots: { slot_start: string; time: string }[] };
}

async function book(slotStart: string, now = NOW) {
  return (await runTool({
    name: "book_slot",
    args: { slot_start: slotStart },
    context,
    handler: bookSlotTool,
    now,
  })) as BookResult;
}

function appointment() {
  return db.query.appointments.findFirst({
    where: eq(schema.appointments.id, seed.appointmentId),
  });
}

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({ clerkId: CLERK_ID, appointmentStartsAt: APPOINTMENT_STARTS_AT });
  context = (await resolveToolContext(seed.retellCallId))!;
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
});

describe("bookSlotTool", () => {
  it("commits the Reschedule for a Slot it offered", async () => {
    const [first] = (await check()).slots;

    const result = await book(first.slot_start);

    expect(result.ok).toBe(true);
    expect(result.booked_time).toBe(first.time);

    const moved = await appointment();
    expect(moved!.startsAt.toISOString()).toBe(first.slot_start);
    expect(moved!.status).toBe("rescheduled");
  });

  it("refuses a time it never offered, however valid that time is", async () => {
    // The rule that makes slot_start a token rather than a datetime the model
    // composes. 11:00 Monday is a genuinely open Slot — it was simply never
    // named in this Call.
    await check();

    const result = await book("2026-08-17T05:30:00.000Z");

    expect(result).toEqual({ ok: false, reason: "not_offered" });
    expect((await appointment())!.startsAt).toEqual(APPOINTMENT_STARTS_AT);
  });

  it("refuses anything that is not a time at all", async () => {
    expect(await book("next Tuesday-ish")).toEqual({ ok: false, reason: "invalid_time" });
  });

  it("refuses an offered Slot that has since passed", async () => {
    const [first] = (await check()).slots;

    // The same Slot, asked for an hour after it started. Offers are unlimited
    // and a negotiation takes time; the world moves underneath one.
    const later = new Date(new Date(first.slot_start).getTime() + 60 * 60_000);
    expect(await book(first.slot_start, later)).toEqual({ ok: false, reason: "in_the_past" });
  });

  it("fails cleanly when another Call took the Slot first", async () => {
    const [first] = (await check()).slots;

    await db.insert(schema.appointments).values({
      businessId: seed.businessId,
      serviceId: seed.serviceId,
      name: "Faster Caller",
      phoneE164: "+919876500002",
      startsAt: new Date(first.slot_start),
      endsAt: new Date(new Date(first.slot_start).getTime() + 60 * 60_000),
      status: "confirmed",
    });

    const result = await book(first.slot_start);
    expect(result).toEqual({ ok: false, reason: "slot_taken" });

    const untouched = await appointment();
    // SPEC.md §8 step 3: the Appointment keeps its original Slot...
    expect(untouched!.startsAt).toEqual(APPOINTMENT_STARTS_AT);
    expect(untouched!.status).toBe("calling");
    // ...and a human is asked to look at it.
    expect(untouched!.needsAttentionReason).toBe("book_failed");
  });

  it("records the failed booking", async () => {
    const [first] = (await check()).slots;
    await db.insert(schema.appointments).values({
      businessId: seed.businessId,
      serviceId: seed.serviceId,
      name: "Faster Caller",
      phoneE164: "+919876500002",
      startsAt: new Date(first.slot_start),
      endsAt: new Date(new Date(first.slot_start).getTime() + 60 * 60_000),
      status: "confirmed",
    });
    await book(first.slot_start);

    const rows = await db
      .select()
      .from(schema.toolInvocations)
      .where(eq(schema.toolInvocations.callId, seed.callId));

    const booking = rows.find((r) => r.toolName === "book_slot");
    expect(booking).toBeDefined();
    expect(booking!.succeeded).toBe(false);
    expect(booking!.result).toEqual({ ok: false, reason: "slot_taken" });
    expect(booking!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("refuses a second booking while still answering check_availability", async () => {
    const offers = (await check()).slots;

    expect((await book(offers[0].slot_start)).ok).toBe(true);

    // Offers stay unlimited after a Reschedule commits — the 120s cap is the
    // backstop, not a turn limit (SPEC.md §7).
    const second = await check();
    expect(second.ok).toBe(true);
    expect(second.slots.length).toBeGreaterThan(0);

    const refused = await book(second.slots[0].slot_start);
    expect(refused).toEqual({ ok: false, reason: "already_booked" });

    // And the first booking stands, untouched by the refusal.
    expect((await appointment())!.startsAt.toISOString()).toBe(offers[0].slot_start);
  });

  it("leaves exactly one successful book_slot on the record", async () => {
    const offers = (await check()).slots;
    await book(offers[0].slot_start);
    await book((await check()).slots[0].slot_start);

    const rows = await db
      .select()
      .from(schema.toolInvocations)
      .where(eq(schema.toolInvocations.callId, seed.callId));

    const bookings = rows.filter((r) => r.toolName === "book_slot");
    expect(bookings.filter((r) => r.succeeded)).toHaveLength(1);
    expect(bookings.filter((r) => !r.succeeded)).toHaveLength(1);
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/tools/book-slot.test.ts`
Expected: FAIL — cannot resolve `@/lib/tools/book-slot`.

- [x] **Step 3: Implement it**

`lib/tools/book-slot.ts`:

```ts
import { eq } from "drizzle-orm";

import { rescheduleAppointment } from "@/lib/appointments/reschedule";
import { slotIsOffered } from "@/lib/availability/offered";
import { schema } from "@/lib/db";
import { offeredSlotsInCall } from "@/lib/tools/offers";
import { spokenTime } from "@/lib/tools/spoken-time";
import type { ToolHandler, ToolOutcome } from "@/lib/tools/run";

/**
 * `book_slot` — the moment the product does what it promises. The Reschedule
 * commits while the person is still on the line (ADR-0003), not from a
 * transcript someone parses afterwards.
 *
 * Four checks, in this order, because each is cheaper than the next and each
 * failure means something different to the person on the phone:
 *
 * 1. Is `slot_start` a time at all?
 * 2. Did we offer it in **this** Call? (`lib/tools/offers.ts`)
 * 3. Is it inside Business Hours and still ahead? (`lib/availability/offered.ts`)
 * 4. Move the Appointment, and let `appointments_no_overlap` settle the race.
 *
 * Check 3 looks redundant after check 2 and is not. A Slot offered forty seconds
 * ago can be in the past by the time it is booked, and Business Hours can be
 * edited in Settings mid-Call. Check 2 asks "did we say this?"; check 3 asks "is
 * it still true?".
 *
 * **The one thing here with no acceptable workaround:** this never returns
 * `ok: true` for a write that did not happen. SPEC.md §3 rule 7 and §14 rule 4 —
 * Maya claiming a booking succeeded when it failed is the most damaging failure
 * available to this product.
 */

/** SPEC.md §8: "Retry once, silently." So two attempts, not two retries. */
const ATTEMPTS = 2;

export type BookSlotRefusal =
  | "invalid_time"
  | "not_offered"
  | "in_the_past"
  | "slot_taken";

const refuse = (reason: BookSlotRefusal): ToolOutcome => ({
  succeeded: false,
  result: { ok: false, reason },
});

export const bookSlotTool: ToolHandler = async ({ tx, context, args, now }) => {
  const slotStart = args.slot_start;
  if (typeof slotStart !== "string") return refuse("invalid_time");

  const startsAt = new Date(slotStart);
  if (Number.isNaN(startsAt.getTime())) return refuse("invalid_time");

  /*
    Compared on the normalised instant, not the raw string. The model is told to
    copy `slot_start` exactly (lib/retell/tools.ts), and it usually will — but
    "…+00:00" and "…Z" are the same moment, and refusing a booking the customer
    just agreed to over a formatting difference is the wrong way to be strict.
    The check that matters is that we named this instant, and that survives
    normalising.
  */
  const token = startsAt.toISOString();
  const offered = await offeredSlotsInCall(tx, context.callId);
  if (!offered.has(token)) return refuse("not_offered");

  /*
    SPEC.md §3 rule 6 and §14 rule 1, enforced in the Tool and never in the
    prompt. `slotIsOffered` deliberately does not look at other Appointments —
    that is the constraint's job, and asking here would be a check-then-write.
  */
  const stillOpen = await slotIsOffered({
    businessId: context.businessId,
    serviceId: context.serviceId,
    startsAt,
    now,
  });
  if (stillOpen === "in_the_past") return refuse("in_the_past");
  if (stillOpen !== "offered") return refuse("not_offered");

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const moved = await rescheduleAppointment({
      tx,
      appointmentId: context.appointment.id,
      durationMinutes: context.durationMinutes,
      startsAt,
    });

    if (moved.ok) {
      return {
        succeeded: true,
        result: {
          ok: true,
          // Read back to the customer. SPEC.md §7 step 3.
          booked_time: spokenTime(startsAt, context.timezone),
        },
      };
    }
    /*
      Lost the race. Try once more without saying anything — the winner may
      itself have been rolled back, and a silent retry costs one statement. Each
      attempt runs on its own savepoint inside `rescheduleAppointment`, which is
      what keeps this transaction alive to make the second one.
    */
  }

  /*
    SPEC.md §8 step 3. The Appointment keeps its original Slot and a human is
    asked to look at it — Callzie will not call this person again until someone
    clears it (SPEC.md §5). #15 renders this; #10 only writes it.
  */
  await tx
    .update(schema.appointments)
    .set({ needsAttentionReason: "book_failed" })
    .where(eq(schema.appointments.id, context.appointment.id));

  return refuse("slot_taken");
};
```

- [x] **Step 4: Run it to verify it passes**

Run: `npx vitest run lib/tools/book-slot.test.ts`
Expected: PASS, 8 tests.

- [x] **Step 5: Commit**

```bash
git add lib/tools/book-slot.ts lib/tools/book-slot.test.ts
git commit -m "Commit the Reschedule, but only into a Slot this Call was offered"
```

---

### Task 12: `confirm_appointment` and `cancel_appointment`

**Files:**
- Create: `lib/tools/confirm-appointment.ts`
- Create: `lib/tools/cancel-appointment.ts`
- Test: `lib/tools/confirm-cancel.test.ts`

- [x] **Step 1: Write the failing test**

`lib/tools/confirm-cancel.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findAvailableSlots } from "@/lib/availability/find";
import { db, schema } from "@/lib/db";
import { cancelAppointment } from "@/lib/tools/cancel-appointment";
import { confirmAppointment } from "@/lib/tools/confirm-appointment";
import { resolveToolContext, type ToolContext } from "@/lib/tools/request";
import { runTool } from "@/lib/tools/run";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

const CLERK_ID = "user_test_tools_confirm_cancel";
const APPOINTMENT_STARTS_AT = new Date("2026-08-17T03:30:00.000Z");
const NOW = new Date("2026-08-17T02:30:00.000Z");

let seed: ToolTestSeed;
let context: ToolContext;

function appointment() {
  return db.query.appointments.findFirst({
    where: eq(schema.appointments.id, seed.appointmentId),
  });
}

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({ clerkId: CLERK_ID, appointmentStartsAt: APPOINTMENT_STARTS_AT });
  context = (await resolveToolContext(seed.retellCallId))!;
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
});

describe("confirmAppointment", () => {
  it("confirms the existing time", async () => {
    const result = await runTool({
      name: "confirm_appointment",
      args: {},
      context,
      handler: confirmAppointment,
      now: NOW,
    });

    expect(result).toEqual({ ok: true });

    const confirmed = await appointment();
    expect(confirmed!.status).toBe("confirmed");
    // Confirming does not move anything.
    expect(confirmed!.startsAt).toEqual(APPOINTMENT_STARTS_AT);
  });

  it("succeeds a second time", async () => {
    // Maya occasionally calls a Tool twice. A second confirmation is not an
    // error worth making her explain to the customer.
    await runTool({ name: "confirm_appointment", args: {}, context, handler: confirmAppointment, now: NOW });
    const again = await runTool({ name: "confirm_appointment", args: {}, context, handler: confirmAppointment, now: NOW });

    expect(again).toEqual({ ok: true });
    expect((await appointment())!.status).toBe("confirmed");
  });
});

describe("cancelAppointment", () => {
  it("cancels the Appointment", async () => {
    const result = await runTool({
      name: "cancel_appointment",
      args: {},
      context,
      handler: cancelAppointment,
      now: NOW,
    });

    expect(result).toEqual({ ok: true });
    expect((await appointment())!.status).toBe("cancelled");
  });

  it("frees the Slot", async () => {
    const held = await findAvailableSlots({
      businessId: seed.businessId,
      serviceId: seed.serviceId,
      from: NOW,
      to: new Date("2026-08-17T11:30:00.000Z"),
      now: NOW,
    });
    expect(held.map((s) => s.startsAt.toISOString()))
      .not.toContain(APPOINTMENT_STARTS_AT.toISOString());

    await runTool({ name: "cancel_appointment", args: {}, context, handler: cancelAppointment, now: NOW });

    // No separate "release the Slot" step: `cancelled` is one of
    // SLOT_FREEING_STATUSES, so the constraint and Availability both stop
    // counting it at once, and cannot disagree.
    const freed = await findAvailableSlots({
      businessId: seed.businessId,
      serviceId: seed.serviceId,
      from: NOW,
      to: new Date("2026-08-17T11:30:00.000Z"),
      now: NOW,
    });
    expect(freed.map((s) => s.startsAt.toISOString()))
      .toContain(APPOINTMENT_STARTS_AT.toISOString());
  });

  it("is recorded like every other Tool", async () => {
    await runTool({ name: "cancel_appointment", args: {}, context, handler: cancelAppointment, now: NOW });

    const [row] = await db
      .select()
      .from(schema.toolInvocations)
      .where(eq(schema.toolInvocations.callId, seed.callId));

    expect(row.toolName).toBe("cancel_appointment");
    expect(row.succeeded).toBe(true);
    expect(row.arguments).toEqual({});
  });
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run lib/tools/confirm-cancel.test.ts`
Expected: FAIL — cannot resolve the two modules.

- [x] **Step 3: Implement both**

`lib/tools/confirm-appointment.ts`:

```ts
import { eq } from "drizzle-orm";

import { schema } from "@/lib/db";
import type { ToolHandler } from "@/lib/tools/run";

/**
 * `confirm_appointment` — the person can make their time after all.
 *
 * No arguments, by design: it acts on the Appointment this Call is already
 * about, and `lib/retell/tools.ts` explains why no Tool takes an identifier.
 *
 * Idempotent. Confirming an already-confirmed Appointment succeeds, because Maya
 * occasionally calls a Tool twice and a second confirmation is not a problem
 * worth making her explain to the customer.
 */
export const confirmAppointment: ToolHandler = async ({ tx, context }) => {
  await tx
    .update(schema.appointments)
    .set({ status: "confirmed" })
    .where(eq(schema.appointments.id, context.appointment.id));

  return { succeeded: true, result: { ok: true } };
};
```

`lib/tools/cancel-appointment.ts`:

```ts
import { eq } from "drizzle-orm";

import { schema } from "@/lib/db";
import type { ToolHandler } from "@/lib/tools/run";

/**
 * `cancel_appointment` — the person does not want the Appointment at all.
 *
 * **The Slot frees itself.** `cancelled` is one of `SLOT_FREEING_STATUSES`, so
 * `appointments_no_overlap` stops counting the row and `findAvailableSlots`
 * stops subtracting it, in the same instant. There is no separate "release the
 * Slot" step, and therefore no way for the constraint and Availability to
 * disagree about whether that time is open.
 *
 * Note what this does **not** cover. SPEC.md §14 rule 2 says a Slot is never
 * freed on a weak signal — a person saying "cancel it" is not a weak signal, an
 * unanswered phone is, and that path belongs to #17.
 */
export const cancelAppointment: ToolHandler = async ({ tx, context }) => {
  await tx
    .update(schema.appointments)
    .set({ status: "cancelled" })
    .where(eq(schema.appointments.id, context.appointment.id));

  return { succeeded: true, result: { ok: true } };
};
```

- [x] **Step 4: Run it to verify it passes**

Run: `npx vitest run lib/tools/confirm-cancel.test.ts`
Expected: PASS, 5 tests.

- [x] **Step 5: Commit**

```bash
git add lib/tools/confirm-appointment.ts lib/tools/cancel-appointment.ts lib/tools/confirm-cancel.test.ts
git commit -m "Confirm the existing time, or cancel and free the Slot"
```

---

### Task 13: The routes, the front door and `proxy.ts`

**Files:**
- Create: `lib/tools/handle.ts`
- Create: `app/api/tools/check-availability/route.ts`
- Create: `app/api/tools/book-slot/route.ts`
- Create: `app/api/tools/confirm-appointment/route.ts`
- Create: `app/api/tools/cancel-appointment/route.ts`
- Modify: `proxy.ts`

- [x] **Step 1: Write the shared front door**

`lib/tools/handle.ts`:

```ts
import { NextResponse } from "next/server";

import type { ToolName } from "@/lib/db/schema";
import { isAuthorised } from "@/lib/tools/auth";
import { parseToolRequest, resolveToolContext } from "@/lib/tools/request";
import { runTool, type ToolHandler } from "@/lib/tools/run";

/**
 * Everything the four Tool routes do before they differ.
 *
 * Here rather than duplicated four times, because the auth check is the security
 * boundary and four copies is four chances for one of them to drift.
 *
 * **The status codes.** `4xx` means this request should never have been made and
 * there is nothing for Maya to say. A business refusal is different — "that time
 * just went" is part of the conversation — so it comes back as `200` with
 * `{ ok: false, reason }` and she reads it.
 *
 * Nothing is recorded for a 401, 400 or 404: `tool_invocations.call_id` is NOT
 * NULL with a foreign key, so a request we cannot tie to a Call has no row to
 * write. That is a real gap, taken deliberately — the alternative is a nullable
 * `call_id` that every reader of the table then has to handle, for a case that
 * only ever means "someone posted garbage".
 */
export async function handleToolRequest(
  request: Request,
  name: ToolName,
  handler: ToolHandler,
): Promise<NextResponse> {
  // First, before the body is even read. An unauthenticated caller learns
  // nothing about whether their payload was well-formed.
  if (!isAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = parseToolRequest(body);
  if (!parsed) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const context = await resolveToolContext(parsed.callId);
  if (!context) {
    return NextResponse.json({ error: "unknown_call" }, { status: 404 });
  }

  /*
    `parsed.name` is deliberately ignored in favour of the route's own `name`.
    The route is the authority on which Tool this is — trusting the body would
    let a caller record a book_slot as a check_availability, which is exactly the
    field the one-booking index keys on.
  */
  const result = await runTool({ name, args: parsed.args, context, handler });

  return NextResponse.json(result);
}
```

- [x] **Step 2: Write the four routes**

`app/api/tools/check-availability/route.ts`:

```ts
import type { NextResponse } from "next/server";

import { checkAvailability } from "@/lib/tools/check-availability";
import { handleToolRequest } from "@/lib/tools/handle";

/*
  Served at the path lib/retell/tools.ts declares in TOOL_PATHS. Retell posts
  here mid-call with `Authorization: Bearer ${INTERNAL_SECRET}`, baked in when
  the Agent was created.
*/
export async function POST(request: Request): Promise<NextResponse> {
  return handleToolRequest(request, "check_availability", checkAvailability);
}
```

`app/api/tools/book-slot/route.ts`:

```ts
import type { NextResponse } from "next/server";

import { bookSlotTool } from "@/lib/tools/book-slot";
import { handleToolRequest } from "@/lib/tools/handle";

export async function POST(request: Request): Promise<NextResponse> {
  return handleToolRequest(request, "book_slot", bookSlotTool);
}
```

`app/api/tools/confirm-appointment/route.ts`:

```ts
import type { NextResponse } from "next/server";

import { confirmAppointment } from "@/lib/tools/confirm-appointment";
import { handleToolRequest } from "@/lib/tools/handle";

export async function POST(request: Request): Promise<NextResponse> {
  return handleToolRequest(request, "confirm_appointment", confirmAppointment);
}
```

`app/api/tools/cancel-appointment/route.ts`:

```ts
import type { NextResponse } from "next/server";

import { cancelAppointment } from "@/lib/tools/cancel-appointment";
import { handleToolRequest } from "@/lib/tools/handle";

export async function POST(request: Request): Promise<NextResponse> {
  return handleToolRequest(request, "cancel_appointment", cancelAppointment);
}
```

- [x] **Step 3: Open the routes in `proxy.ts`**

In `proxy.ts`, add to the `createRouteMatcher` array, after the webhooks entry:

```ts
  /*
    Retell posts here mid-call with the internal secret in a header
    (lib/tools/auth.ts). "Public" means only that a Clerk session cookie is not
    the gate — the secret is, and it is stricter, because Callzie is open signup
    and a cookie would let any account that exists write to any Appointment.

    Left protected, Clerk would 302 every Tool call to the sign-in page. Maya
    would experience a Tool that never works, with nothing in the logs saying
    "auth".
  */
  "/api/tools(.*)",
```

- [x] **Step 4: Check it compiles**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run lint`
Expected: no errors.

- [x] **Step 5: Commit**

```bash
git add lib/tools/handle.ts app/api/tools proxy.ts
git commit -m "Serve the four Tools at the paths lib/retell/tools.ts already declares"
```

---

### Task 14: Driving the endpoints exactly as Retell would

**Files:**
- Create: `fixtures/retell/tools/check-availability.json`
- Create: `fixtures/retell/tools/book-slot.json`
- Create: `fixtures/retell/tools/confirm-appointment.json`
- Create: `fixtures/retell/tools/cancel-appointment.json`
- Test: `app/api/tools/routes.test.ts`

- [x] **Step 1: Write the fixtures**

`fixtures/retell/tools/check-availability.json`:

```json
{
  "name": "check_availability",
  "call": {
    "call_id": "CALL_ID_PLACEHOLDER",
    "agent_id": "agent_fixture",
    "call_type": "web_call",
    "call_status": "ongoing",
    "transcript": "Agent: Hi Priya, this is Maya calling about your haircut on Monday at 9am. Does that still work?\nUser: Sorry, no, something's come up."
  },
  "args": { "preferred_time": "Thursday afternoon" }
}
```

`fixtures/retell/tools/book-slot.json`:

```json
{
  "name": "book_slot",
  "call": {
    "call_id": "CALL_ID_PLACEHOLDER",
    "agent_id": "agent_fixture",
    "call_type": "web_call",
    "call_status": "ongoing",
    "transcript": "Agent: I have 10am on Monday. Does that work?\nUser: Yes, that's perfect."
  },
  "args": { "slot_start": "SLOT_START_PLACEHOLDER" }
}
```

`fixtures/retell/tools/confirm-appointment.json`:

```json
{
  "name": "confirm_appointment",
  "call": {
    "call_id": "CALL_ID_PLACEHOLDER",
    "agent_id": "agent_fixture",
    "call_type": "web_call",
    "call_status": "ongoing",
    "transcript": "Agent: Does Monday at 9am still work?\nUser: Yes, that's fine."
  },
  "args": {}
}
```

`fixtures/retell/tools/cancel-appointment.json`:

```json
{
  "name": "cancel_appointment",
  "call": {
    "call_id": "CALL_ID_PLACEHOLDER",
    "agent_id": "agent_fixture",
    "call_type": "web_call",
    "call_status": "ongoing",
    "transcript": "Agent: Would another time suit you better?\nUser: No, please just cancel it."
  },
  "args": {}
}
```

- [x] **Step 2: Write the failing test**

`app/api/tools/routes.test.ts`:

```ts
import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as bookSlotRoute } from "@/app/api/tools/book-slot/route";
import { POST as cancelRoute } from "@/app/api/tools/cancel-appointment/route";
import { POST as checkRoute } from "@/app/api/tools/check-availability/route";
import { POST as confirmRoute } from "@/app/api/tools/confirm-appointment/route";
import { db, schema } from "@/lib/db";
import { TOOL_PATHS } from "@/lib/retell/tools";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

/*
  The acceptance criteria, driven through the real route handlers by a fixture
  shaped exactly as docs/verification.md A12 records Retell's body.

  No server is started and no socket is opened. Next 16 route handlers are plain
  functions over the Web Request/Response types, so this is the real handler on
  the real path rather than a stand-in — and the whole file costs nothing to run
  (SPEC.md §10).
*/

const CLERK_ID = "user_test_tools_routes";
const SECRET = "routes-test-internal-secret";

const APPOINTMENT_STARTS_AT = new Date("2026-08-17T03:30:00.000Z");

let seed: ToolTestSeed;

type Fixture = "check-availability" | "book-slot" | "confirm-appointment" | "cancel-appointment";

function fixture(name: Fixture): Record<string, unknown> {
  return JSON.parse(readFileSync(`./fixtures/retell/tools/${name}.json`, "utf8"));
}

/** The Request Retell would send, with the placeholders filled in. */
function toolRequest(
  name: Fixture,
  options: { slotStart?: string; headers?: Record<string, string> } = {},
): Request {
  const body = fixture(name);
  (body.call as { call_id: string }).call_id = seed.retellCallId;
  if (options.slotStart) {
    (body.args as { slot_start: string }).slot_start = options.slotStart;
  }

  return new Request(`http://localhost${TOOL_PATHS[body.name as keyof typeof TOOL_PATHS]}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? { Authorization: `Bearer ${SECRET}` }),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  vi.stubEnv("INTERNAL_SECRET", SECRET);
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({ clerkId: CLERK_ID, appointmentStartsAt: APPOINTMENT_STARTS_AT });
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
  vi.unstubAllEnvs();
});

const ROUTES = [
  ["check_availability", checkRoute, "check-availability"],
  ["book_slot", bookSlotRoute, "book-slot"],
  ["confirm_appointment", confirmRoute, "confirm-appointment"],
  ["cancel_appointment", cancelRoute, "cancel-appointment"],
] as const;

describe("every Tool endpoint is reachable only with the internal secret", () => {
  it.each(ROUTES)("%s refuses a request with no credential", async (_name, route, file) => {
    const response = await route(toolRequest(file, { headers: {} }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it.each(ROUTES)("%s refuses the wrong secret", async (_name, route, file) => {
    const response = await route(
      toolRequest(file, { headers: { Authorization: "Bearer wrong" } }),
    );
    expect(response.status).toBe(401);
  });

  it.each(ROUTES)("%s accepts X-Callzie-Secret as well", async (_name, route, file) => {
    // docs/verification.md A12: whether Retell forwards Authorization unmodified
    // is unverified, and this is the named fallback.
    const response = await route(
      toolRequest(file, { headers: { "X-Callzie-Secret": SECRET } }),
    );
    expect(response.status).toBe(200);
  });

  it("records nothing for a rejected request", async () => {
    await checkRoute(toolRequest("check-availability", { headers: {} }));
    expect(await db.select().from(schema.toolInvocations)).toHaveLength(0);
  });
});

describe("malformed and unknown requests", () => {
  it("returns 400 for a body that is not Retell's envelope", async () => {
    const response = await checkRoute(
      new Request("http://localhost/api/tools/check-availability", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({ nonsense: true }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("returns 400 for a body that is not JSON at all", async () => {
    const response = await checkRoute(
      new Request("http://localhost/api/tools/check-availability", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${SECRET}` },
        body: "not json",
      }),
    );
    expect(response.status).toBe(400);
  });

  it("returns 404 for a call_id nothing knows about", async () => {
    const body = fixture("check-availability");
    (body.call as { call_id: string }).call_id = "call_never_existed";

    const response = await checkRoute(
      new Request("http://localhost/api/tools/check-availability", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${SECRET}` },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "unknown_call" });
  });
});

describe("the full negotiation, as Retell would drive it", () => {
  it("checks, books, keeps checking, and refuses the second booking", async () => {
    // 1. She cannot make her time, so Maya asks what is open.
    const first = await (await checkRoute(toolRequest("check-availability"))).json();
    expect(first.ok).toBe(true);
    expect(first.slots.length).toBeGreaterThan(0);

    // 2. She rejects those, so Maya asks again. Offers are unlimited (SPEC.md §7).
    const second = await (await checkRoute(toolRequest("check-availability"))).json();
    expect(second.slots.length).toBeGreaterThan(0);

    // 3. She takes one.
    const booked = await (
      await bookSlotRoute(toolRequest("book-slot", { slotStart: second.slots[1].slot_start }))
    ).json();
    expect(booked.ok).toBe(true);
    expect(booked.booked_time).toBe(second.slots[1].time);

    // 4. Further checks still work — the cap is on Reschedules, not on Offers.
    const third = await (await checkRoute(toolRequest("check-availability"))).json();
    expect(third.ok).toBe(true);

    // 5. A second Reschedule is refused.
    const again = await (
      await bookSlotRoute(toolRequest("book-slot", { slotStart: third.slots[0].slot_start }))
    ).json();
    expect(again).toEqual({ ok: false, reason: "already_booked" });

    // The Appointment sits where the first booking put it.
    const appointment = await db.query.appointments.findFirst({
      where: eq(schema.appointments.id, seed.appointmentId),
    });
    expect(appointment!.startsAt.toISOString()).toBe(second.slots[1].slot_start);
    expect(appointment!.status).toBe("rescheduled");
  });

  it("records every invocation with its arguments, result and success flag", async () => {
    await checkRoute(toolRequest("check-availability"));
    const offered = await (await checkRoute(toolRequest("check-availability"))).json();
    await bookSlotRoute(toolRequest("book-slot", { slotStart: offered.slots[0].slot_start }));
    await bookSlotRoute(toolRequest("book-slot", { slotStart: offered.slots[1].slot_start }));

    const rows = await db
      .select()
      .from(schema.toolInvocations)
      .where(eq(schema.toolInvocations.callId, seed.callId));

    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.arguments).toBeTypeOf("object");
      expect(row.result).not.toBeNull();
      expect(row.succeeded).toBeTypeOf("boolean");
      // Acceptance criterion 6: a slow Tool is dead air on a live call.
      expect(row.latencyMs).toBeTypeOf("number");
      expect(row.latencyMs).toBeGreaterThanOrEqual(0);
    }

    const bookings = rows.filter((r) => r.toolName === "book_slot");
    expect(bookings.filter((r) => r.succeeded)).toHaveLength(1);
    expect(bookings.filter((r) => !r.succeeded)).toHaveLength(1);

    // The recorded arguments are the ones the model actually sent.
    const check = rows.find((r) => r.toolName === "check_availability");
    expect(check!.arguments).toEqual({ preferred_time: "Thursday afternoon" });
  });

  it("confirms the existing time", async () => {
    const response = await confirmRoute(toolRequest("confirm-appointment"));
    expect(await response.json()).toEqual({ ok: true });

    const appointment = await db.query.appointments.findFirst({
      where: eq(schema.appointments.id, seed.appointmentId),
    });
    expect(appointment!.status).toBe("confirmed");
    expect(appointment!.startsAt).toEqual(APPOINTMENT_STARTS_AT);
  });

  it("cancels and frees the Slot", async () => {
    const response = await cancelRoute(toolRequest("cancel-appointment"));
    expect(await response.json()).toEqual({ ok: true });

    const appointment = await db.query.appointments.findFirst({
      where: eq(schema.appointments.id, seed.appointmentId),
    });
    expect(appointment!.status).toBe("cancelled");
  });
});

describe("the declared paths and the routes on disk agree", () => {
  it.each(Object.entries(TOOL_PATHS))("%s is served at %s", (_name, path) => {
    // lib/retell/tools.ts bakes these into every Agent at creation time. A
    // renamed directory would 404 mid-call and the script would never notice.
    expect(() => readFileSync(`.${path}/route.ts`, "utf8")).not.toThrow();
  });
});
```

- [x] **Step 3: Run it to verify it fails, then passes**

Run: `npx vitest run app/api/tools/routes.test.ts`
Expected: FAIL first if any route is missing; PASS once Task 13 is in place.

- [x] **Step 4: Commit**

```bash
git add fixtures/retell/tools app/api/tools/routes.test.ts
git commit -m "Drive all four endpoints from fixtures shaped exactly as Retell posts them"
```

---

### Task 15: Prove the one-booking rule is the database's, not the code's

Without this, Task 11's "second booking refused" test could be passing because the application happens to order its own writes — and it would keep passing if someone dropped the index.

**Files:**
- Test: `lib/tools/one-booking.test.ts`

- [x] **Step 1: Write the test**

`lib/tools/one-booking.test.ts`:

```ts
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import { resolveToolContext, type ToolContext } from "@/lib/tools/request";
import { runTool } from "@/lib/tools/run";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

/*
  This file DROPS `tool_invocations_one_booking_per_call` and restores it
  afterwards — the same technique lib/availability/book.test.ts uses on
  `appointments_no_overlap`, and safe for the same reason: the database is local
  and disposable, and vitest.globalSetup.ts re-migrates it on every run.

  It relies on `fileParallelism: false` in vitest.config.mts. No other file may
  observe the index missing.
*/

const CLERK_ID = "user_test_tools_one_booking";
const APPOINTMENT_STARTS_AT = new Date("2026-08-17T03:30:00.000Z");
const INDEX = "tool_invocations_one_booking_per_call";

let seed: ToolTestSeed;
let context: ToolContext;

async function indexExists(): Promise<boolean> {
  const result = await db.execute(
    sql`SELECT 1 FROM pg_class WHERE relname = ${INDEX} AND relkind = 'i'`,
  );
  return result.rows.length > 0;
}

async function restoreIndex() {
  if (await indexExists()) return;
  await db.execute(sql`
    CREATE UNIQUE INDEX "tool_invocations_one_booking_per_call"
      ON "tool_invocations" ("call_id")
      WHERE "tool_name" = 'book_slot' AND "succeeded"
  `);
}

/** A book_slot that always succeeds, so only the index can refuse it. */
function commitABooking() {
  return runTool({
    name: "book_slot",
    args: {},
    context,
    handler: async () => ({ succeeded: true, result: { ok: true } }),
  });
}

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({ clerkId: CLERK_ID, appointmentStartsAt: APPOINTMENT_STARTS_AT });
  context = (await resolveToolContext(seed.retellCallId))!;
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
  // Restore before the next file runs, whatever happened above.
  await restoreIndex();
});

describe("the index, not the code, is what caps a Call at one Reschedule", () => {
  it("commits two Reschedules once the index is removed", async () => {
    expect(await indexExists()).toBe(true);

    await db.execute(sql`DROP INDEX "tool_invocations_one_booking_per_call"`);
    expect(await indexExists()).toBe(false);

    // The defect, reproduced. Nothing in application code counts bookings, so
    // with the index gone both succeed — which is what proves the test in
    // lib/tools/book-slot.test.ts is testing the index rather than luck.
    expect(await commitABooking()).toEqual({ ok: true });
    expect(await commitABooking()).toEqual({ ok: true });

    const bookings = await db
      .select()
      .from(schema.toolInvocations)
      .where(eq(schema.toolInvocations.callId, seed.callId));
    expect(bookings.filter((r) => r.succeeded).length).toBeGreaterThan(1);
  });

  it("has the index back afterwards", async () => {
    // afterEach restores it. This asserts the restore works, so the test above
    // cannot silently disarm every later file.
    expect(await indexExists()).toBe(true);
    expect(await commitABooking()).toEqual({ ok: true });
    expect(await commitABooking()).toEqual({ ok: false, reason: "already_booked" });
  });
});
```

- [x] **Step 2: Run it**

Run: `npx vitest run lib/tools/one-booking.test.ts`
Expected: PASS, 2 tests.

- [x] **Step 3: Run the whole suite**

Run: `npm test`
Expected: everything passes. The index must be back — if a later file fails on `already_booked`, `restoreIndex` is broken.

- [x] **Step 4: Commit**

```bash
git add lib/tools/one-booking.test.ts
git commit -m "Prove the one-booking cap is the index, by dropping it and watching it fail"
```

---

### Task 16: Write down what was decided

**Files:**
- Create: `docs/adr/0011-tools-prove-an-offer-by-replaying-tool-invocations.md`
- Modify: `docs/verification.md`
- Modify: `docs/superpowers/specs/2026-08-19-tool-endpoints-design.md`

- [x] **Step 1: Write the ADR**

`docs/adr/0011-tools-prove-an-offer-by-replaying-tool-invocations.md`:

```markdown
# Tools prove an Offer by replaying tool_invocations, and cap Reschedules with an index

Status: accepted

Two rules SPEC.md states in prose needed a mechanism, and both ended up in the
same place: the `tool_invocations` table Callzie was already required to write.

**Only a Slot this Call was Offered may be booked.** `check_availability` returns
`slot_start`; `book_slot` echoes it back; the endpoint reads that Call's earlier
`check_availability` rows and refuses anything that does not appear in one. So
SPEC.md §7's "Only ever offer times check_availability returned" is enforced
rather than requested — and date arithmetic stays out of an LLM's hands, because
the model copies a token instead of composing a datetime.

**Exactly one Reschedule commits per Call.** A partial unique index on
`tool_invocations (call_id) WHERE tool_name = 'book_slot' AND succeeded`. Every
Tool therefore runs in one transaction that also writes its own record: when the
index refuses the second booking's record, the booking rolls back with it.

## Considered options

- **Signing each `slot_start` with `INTERNAL_SECRET`.** Stateless, one fewer
  query. Rejected: it adds a second secret-signing scheme beside
  `lib/google/oauth.ts`, and the record it would replace has to be written
  anyway. A cache is a second copy of the truth, and a second copy can disagree.
- **Checking the Offer and the booking count in application code.** Rejected for
  the count: it is check-then-write, the pattern ADR-0010's ticket and SPEC.md §3
  rule 8 exist to rule out, and a check nothing tests is a check someone deletes.
- **Deriving "already booked" from `appointments.status = 'rescheduled'`.**
  Rejected: it says nothing about the Call, so a human rescheduling the row
  between two Calls would block the second Call's Agent from doing its job.
- **Parsing `preferred_time`.** Deferred, not rejected. The argument is recorded
  so the phrases people actually use can be read off the table before a parser is
  written for imagined ones.

## Consequences

- **`tool_invocations` is load-bearing, not an audit log.** It was already the
  authoritative record of the outcome (SPEC.md §9 step 3); it is now also an
  input to `book_slot`. Anything that prunes it changes behaviour.
- **A constraint rejection needs a savepoint.** Postgres aborts a whole
  transaction on a failed statement, so SPEC.md §8's silent retry, the
  `book_failed` write and the record itself would all fail after a lost race.
  `lib/appointments/reschedule.ts` runs each attempt on its own savepoint.
- **Both `Authorization` and `X-Callzie-Secret` are accepted**, because
  `docs/verification.md` A12 records it as unverified whether Retell forwards the
  first. The cost is six lines; the alternative is finding out mid-call.
- **The Offer check is per Call, not per Offer.** A time named in turn two stays
  bookable in turn nine — "actually, the first one you said" is a real thing
  people say.
```

- [x] **Step 2: Close the open items in `docs/verification.md`**

In A12, under "Other traps", replace the `Authorization` bullet with:

```markdown
- **Whether Retell forwards an `Authorization` header unmodified is still
  UNVERIFIED, and no longer blocking.** `lib/tools/auth.ts` accepts the secret
  from either `Authorization: Bearer` or `X-Callzie-Secret`, so a stripped or
  rewritten header degrades to the fallback rather than to a 401 mid-call.
  *Settled for good by* issue #12's first live Tool invocation.
```

And in the A12 preamble, replace the latency sentence with:

```markdown
The latency half — how long a Tool may take before the Agent stalls audibly — is
still **UNVERIFIED**, but now measurable: issue #10 added `tool_invocations.latency_ms`
and every invocation records it. *Settled by* issue #12, on a live call.
```

- [x] **Step 3: Mark the design implemented**

In `docs/superpowers/specs/2026-08-19-tool-endpoints-design.md`, change the
status line to:

```markdown
**Status:** Implemented. See `docs/superpowers/plans/2026-08-19-tool-endpoints.md`
```

- [x] **Step 4: Final verification**

Run: `npm test`
Expected: all tests pass.

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run lint`
Expected: no errors.

Run: `npm run build`
Expected: builds. The four new routes appear in the route list.

- [x] **Step 5: Commit**

```bash
git add docs/
git commit -m "Record how the Tools prove an Offer and cap a Call at one Reschedule"
```

---

## Definition of done

Every acceptance criterion on issue #10, with the test that proves it:

| Criterion | Proven by |
|---|---|
| Reachable only with the internal secret | `app/api/tools/routes.test.ts`, `lib/tools/auth.test.ts` |
| Never a Slot outside Business Hours or in the past | `lib/tools/check-availability.test.ts` |
| `book_slot` into an occupied Slot fails cleanly | `lib/tools/book-slot.test.ts` |
| Second `book_slot` refused, further checks are not | `lib/tools/book-slot.test.ts`, `lib/tools/one-booking.test.ts` |
| Every invocation recorded | `lib/tools/run.test.ts`, `app/api/tools/routes.test.ts` |
| Latency measured and recorded | `lib/tools/run.test.ts`, `app/api/tools/routes.test.ts` |
| Covered by fixtures with no telephony spend | `fixtures/retell/tools/`; nothing imports `retell-sdk` |
