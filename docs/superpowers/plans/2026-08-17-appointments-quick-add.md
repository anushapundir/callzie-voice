# Appointments — quick-add, list and seeded demo data: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stub Overview list with a working quick-add card and the full SPEC.md §11.3 Appointments table, so an Appointment can be created by hand into a real open Slot and appears immediately.

**Architecture:** Application code answers only "is the Business open then, and is the time still ahead" — Postgres cannot see `business_hours`, so that check has no constraint to undermine. Overlap is never checked in application code: `bookSlot()` attempts the insert and the `appointments_no_overlap` EXCLUDE constraint's rejection is the only source of "that time is taken". The Overview page is a Server Component; only the quick-add card is a Client Component, and a Server Action returns fresh Slot options when the Service changes.

**Tech Stack:** Next.js 16 App Router, React 19, Drizzle ORM on Postgres, Tailwind 4 (CSS-first tokens in `app/globals.css`), Vitest against a local Postgres started by `vitest.globalSetup.ts`.

**Design doc:** `docs/superpowers/specs/2026-08-17-appointments-quick-add-design.md`

---

## Progress

Tasks 1, 2 and 3 are built and reviewed. Their code blocks below have been
updated to match what actually shipped, so they stay a true record — but two
changes came out of code review rather than out of this plan, and are worth
knowing about before writing Task 4:

- **`lib/appointments/phone.ts` rejects a bracketed trunk zero.**
  `+44 (0) 20 7946 0018` and `+44 (020) 7946 0018` both used to normalise to
  `+4402079460018`, which is a well-formed number that rings nobody — the `(0)`
  is a trunk prefix you drop when dialling internationally. Both are now
  refused with a message saying so. The block in Task 1 below predates that fix;
  read the file, not the block.
- **`loadSchedule` takes an options object**, not two positional ids. Two
  same-typed UUIDs side by side meant a swap would compile and then fail with a
  message naming the wrong kind of thing.

## Change from the design doc

The design doc named the "you are closed then" refusal `outside_hours`. This plan calls it **`not_offered`** instead.

The check works by asking whether `openSlots()` produces a Slot starting at exactly that instant. That refuses two things: a time when the Business is closed, and a time that is inside opening hours but off the Slot grid — 09:07 when Slots run 09:00, 09:45, 10:30. Calling both "outside hours" would be a name that lies, which is the same fault this work fixes in `listUpcomingAppointments`.

Task 14 updates the design doc to match.

---

## File structure

**New — pure, no database**

| File | Responsibility |
|---|---|
| `lib/appointments/phone.ts` | One function: text in, E.164 or a reason out. |
| `lib/appointments/quick-add-input.ts` | Reads the four form fields; owns the `useActionState` state types. |

**New — database**

| File | Responsibility |
|---|---|
| `lib/availability/schedule.ts` | Loads the three facts that define a schedule: timezone, Service duration, Business Hours. Shared by `find.ts` and `offered.ts`. Deliberately does **not** load Appointments. |
| `lib/availability/offered.ts` | Does this Business offer a Slot starting at this instant? Never looks at other Appointments. |
| `lib/appointments/create.ts` | The three-step create. Names the refusals; does not decide them. |
| `lib/business/appointment-stats.ts` | The four stat tiles. |
| `lib/business/list-services.ts` | The Services the picker offers. Separate from `loadSettings`, which also counts Appointments per Service — a query Overview would pay for and never render. |

**New — app**

| File | Responsibility |
|---|---|
| `app/(app)/actions.ts` | `addAppointmentAction` (write), `slotOptionsAction` (read). |
| `components/ui/field-error.tsx` | `FieldError`, moved out of settings so Overview can use it. |
| `components/overview/status-pill.tsx` | §11.2 dot plus label. Owns the status→colour mapping. |
| `components/overview/stat-strip.tsx` | Four tiles. Server Component. |
| `components/overview/quick-call-card.tsx` | The form. The only Client Component. |
| `components/overview/appointments-table.tsx` | The table, and its stacked-card form under `md`. Server Component. |

**Modified**

| File | Change |
|---|---|
| `lib/availability/find.ts` | Use the shared `loadSchedule`. Behaviour unchanged. |
| `lib/business/list-appointments.ts` | Rename to `listAppointments`; add `attempts` and `lastCallId`. |
| `app/(app)/page.tsx` | Render the three new sections. |
| `app/(app)/settings/actions.ts` | One import rename. |
| `components/settings/section.tsx` | `FieldError` moves out. |
| `components/settings/services-section.tsx`, `business-hours-form.tsx`, `business-type-section.tsx` | Import `FieldError` from its new home (only those that use it). |

**Deleted**

| File | |
|---|---|
| `components/overview/appointments-list.tsx` | Replaced by `appointments-table.tsx`. |

---

## Task 1: E.164 phone validation

**Files:**
- Create: `lib/appointments/phone.ts`
- Test: `lib/appointments/phone.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/appointments/phone.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { parseE164 } from "@/lib/appointments/phone";

describe("parseE164", () => {
  it("strips the separators a person types", () => {
    expect(parseE164("+1 (202) 555-0142")).toEqual({
      ok: true,
      value: "+12025550142",
    });
  });

  it("accepts the seed's reserved fictional range unchanged", () => {
    // lib/onboarding/seed-schedule.ts writes +1 202 555 01xx on purpose.
    expect(parseE164("+12025550101")).toEqual({ ok: true, value: "+12025550101" });
  });

  it("accepts a half-hour-zone number at full length", () => {
    expect(parseE164("+91 98200 12345")).toEqual({
      ok: true,
      value: "+919820012345",
    });
  });

  it("asks for a country code when there is no plus", () => {
    expect(parseE164("9820012345")).toEqual({
      ok: false,
      error: "Start with the country code, like +44 or +91.",
    });
  });

  it("rejects an empty field with its own message", () => {
    expect(parseE164("   ")).toEqual({
      ok: false,
      error: "Enter a phone number.",
    });
  });

  it("rejects letters", () => {
    expect(parseE164("+1 202 555 CALL")).toEqual({
      ok: false,
      error: "A phone number can only contain digits, spaces and + ( ) -.",
    });
  });

  it("rejects a country code starting with zero", () => {
    expect(parseE164("+0202555014")).toEqual({
      ok: false,
      error: "A country code never starts with a zero.",
    });
  });

  it("rejects too few digits", () => {
    expect(parseE164("+1234567")).toEqual({
      ok: false,
      error: "That is too short for an international number.",
    });
  });

  it("rejects more than E.164's fifteen digits", () => {
    expect(parseE164("+1234567890123456")).toEqual({
      ok: false,
      error: "That is too long — an international number stops at 15 digits.",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- lib/appointments/phone.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/appointments/phone"`.

- [ ] **Step 3: Write the implementation**

Create `lib/appointments/phone.ts`:

```ts
/**
 * Phone numbers as E.164 (SPEC.md §3 rule 10).
 *
 * E.164 is the international format: a `+`, a country code, then the national
 * number, digits only, 15 digits at most. `+12025550142`.
 *
 * Hand-written rather than `libphonenumber-js`, for two reasons. SPEC.md §2
 * fixes the stack and lists no phone library, and this repo already writes its
 * own validators — `lib/onboarding/input.ts`, `lib/settings/services-input.ts`.
 *
 * **No country is inferred, and none can be.** `businesses` carries an IANA
 * timezone and no country column, so there is nothing to anchor a guess at what
 * `9820012345` means. Requiring the `+` is forced by the data model.
 *
 * **This checks shape, not reachability.** A well-formed number belonging to
 * nobody is accepted. Only placing a Call finds that out, which is #11's
 * problem.
 */

export type ParsedPhone =
  | { ok: true; value: string }
  | { ok: false; error: string };

/** Spaces, dots, dashes and brackets — how people write numbers, not data. */
const SEPARATORS = /[\s.()-]/g;

/** E.164's own bounds: at least 8 digits, never more than 15. */
const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

export function parseE164(raw: string): ParsedPhone {
  if (raw.trim().length === 0) {
    return { ok: false, error: "Enter a phone number." };
  }

  const compact = raw.replace(SEPARATORS, "");

  if (!compact.startsWith("+")) {
    return { ok: false, error: "Start with the country code, like +44 or +91." };
  }

  const digits = compact.slice(1);

  if (!/^\d+$/.test(digits)) {
    return {
      ok: false,
      error: "A phone number can only contain digits, spaces and + ( ) -.",
    };
  }

  // Checked before length, so "+0" gets the message that explains the real
  // problem rather than being judged on how many digits followed it.
  if (digits.startsWith("0")) {
    return { ok: false, error: "A country code never starts with a zero." };
  }

  if (digits.length < MIN_DIGITS) {
    return { ok: false, error: "That is too short for an international number." };
  }

  if (digits.length > MAX_DIGITS) {
    return {
      ok: false,
      error: `That is too long — an international number stops at ${MAX_DIGITS} digits.`,
    };
  }

  return { ok: true, value: `+${digits}` };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- lib/appointments/phone.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/appointments/phone.ts lib/appointments/phone.test.ts
git commit -m "Validate phone numbers to E.164, with a reason per rejection"
```

---

## Task 2: Extract the schedule loader from find.ts

Pure refactor. `findAvailableSlots`'s existing tests must pass untouched — that is the check that this changed nothing.

**Files:**
- Create: `lib/availability/schedule.ts`
- Modify: `lib/availability/find.ts:38-67` (the business, service and hours reads)

- [ ] **Step 1: Write the new module**

Create `lib/availability/schedule.ts`:

```ts
import { and, eq } from "drizzle-orm";

import type { WeekdayWindow } from "@/lib/availability/slots";
import { db, schema } from "@/lib/db";
import { toWallTime } from "@/lib/settings/weekdays";

/**
 * The three facts that define when a Business could take a booking: its
 * timezone, the Service's duration, and its Business Hours.
 *
 * Shared by every caller that has to know where Slot boundaries fall, so no two
 * of them can drift on it.
 *
 * **It deliberately does not load Appointments, and must not start.**
 *
 * The distinction that matters: reading busy times to *show a list* is fine —
 * that is what `find.ts` does, and it loads them itself. Reading them to
 * *decide whether a booking may go ahead* is not. If two Calls both check 09:00
 * at the same moment, both see it free and both try to book it. One has to
 * lose, and Postgres is the only thing positioned to say which.
 *
 * That refusal is `appointments_no_overlap` — a Postgres EXCLUDE constraint,
 * meaning a rule that rejects an insert whose time range overlaps a row already
 * there. `lib/availability/book.ts` explains at length how it is caught and
 * turned back into an ordinary answer, and SPEC.md §3 rule 8 is the rule it
 * enforces. Both are the reference here; `lib/availability/offered.ts` is the
 * caller that depends on this loader staying incomplete.
 */

export type Schedule = {
  /** IANA zone from `businesses.timezone` — Business Hours are local to it. */
  timezone: string;
  /** The Service's length, which is also the Slot size. */
  durationMinutes: number;
  /** One entry per open weekday. Wall-clock `"09:00"`, never an instant. */
  hours: WeekdayWindow[];
};

export type LoadScheduleInput = {
  businessId: string;
  serviceId: string;
};

/*
  An options object rather than two positional arguments, because both are
  opaque id strings of the same type: swapping them would compile, then fail
  with `No Business svc_abc123` — a message naming the wrong kind of thing.
  Every other function in this directory is shaped the same way.
*/
export async function loadSchedule({
  businessId,
  serviceId,
}: LoadScheduleInput): Promise<Schedule> {
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

  return {
    timezone: business.timezone,
    durationMinutes: service.durationMinutes,
    // pg renders a `time` column as "09:00:00"; the pure core expects "09:00".
    // Normalising on the way out of the database is what toWallTime is for.
    hours: hours.map(
      (h): WeekdayWindow => ({
        weekday: h.weekday,
        opensAt: toWallTime(h.opensAt),
        closesAt: toWallTime(h.closesAt),
      }),
    ),
  };
}
```

- [ ] **Step 2: Rewrite find.ts to use it**

Replace the whole body of `findAvailableSlots` in `lib/availability/find.ts`. The file's header comment stays as it is; only the imports and the function change:

```ts
import { and, eq, gt, inArray, lt } from "drizzle-orm";

import { loadSchedule } from "@/lib/availability/schedule";
import { openSlots, type Slot } from "@/lib/availability/slots";
import { db, schema } from "@/lib/db";
import { SLOT_HOLDING_STATUSES } from "@/lib/db/schema";

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
  const { timezone, durationMinutes, hours } = await loadSchedule({
    businessId,
    serviceId,
  });

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

  return openSlots({ hours, timezone, durationMinutes, busy, from, to, now });
}
```

- [ ] **Step 3: Run the existing tests to verify nothing changed**

Run: `npm test -- lib/availability/find.test.ts`
Expected: PASS, all existing tests, with no edits to the test file.

- [ ] **Step 4: Commit**

```bash
git add lib/availability/schedule.ts lib/availability/find.ts
git commit -m "Extract the schedule loader, without the busy Appointments"
```

---

## Task 3: slotIsOffered — hours and past times, never overlap

**Files:**
- Create: `lib/availability/offered.ts`
- Test: `lib/availability/offered.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/availability/offered.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { slotIsOffered } from "@/lib/availability/offered";
import { provisionUser } from "@/lib/auth/provision-user";
import { db, schema } from "@/lib/db";

/*
  Integration against the local Postgres from vitest.globalSetup.ts.

  The Business is built by hand rather than through createOnboardedBusiness,
  because a Template seeds Appointments of its own and this file needs to
  control exactly which times exist.
*/

const CLERK_ID = "user_test_availability_offered";
const TIMEZONE = "Asia/Kolkata";

// A Monday. Open 09:00-17:00 on weekdays, 60-minute Service.
const NOW = new Date("2026-08-16T00:00:00.000Z");
// 09:00 Asia/Kolkata (+05:30) on that Monday.
const NINE_AM = new Date("2026-08-17T03:30:00.000Z");
const TEN_AM = new Date("2026-08-17T04:30:00.000Z");
// 03:00 local — a real instant on an open day, long before opening.
const THREE_AM = new Date("2026-08-16T21:30:00.000Z");
// 09:07 local — inside opening hours, but not on the 60-minute grid.
const SEVEN_PAST_NINE = new Date("2026-08-17T03:37:00.000Z");
// The Monday a week before NOW.
const LAST_MONDAY = new Date("2026-08-10T03:30:00.000Z");

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
    await db
      .delete(schema.services)
      .where(eq(schema.services.businessId, business.id));
    await db
      .delete(schema.businessHours)
      .where(eq(schema.businessHours.businessId, business.id));
    await db.delete(schema.businesses).where(eq(schema.businesses.id, business.id));
  }
  await db.delete(schema.users).where(eq(schema.users.clerkId, CLERK_ID));
}

beforeEach(async () => {
  await cleanup();
  const user = await provisionUser(CLERK_ID, "offered@example.com");

  const [business] = await db
    .insert(schema.businesses)
    .values({
      userId: user.id,
      name: "Offered Test Salon",
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

function offered(startsAt: Date) {
  return slotIsOffered({ businessId, serviceId, startsAt, now: NOW });
}

describe("slotIsOffered", () => {
  it("offers a Slot on the grid inside Business Hours", async () => {
    expect(await offered(NINE_AM)).toBe("offered");
  });

  it("refuses a time when the Business is closed", async () => {
    expect(await offered(THREE_AM)).toBe("not_offered");
  });

  it("refuses a time inside hours but off the Slot grid", async () => {
    expect(await offered(SEVEN_PAST_NINE)).toBe("not_offered");
  });

  it("refuses a time that has already passed", async () => {
    expect(await offered(LAST_MONDAY)).toBe("in_the_past");
  });

  it("still offers a Slot that another Appointment already holds", async () => {
    // The point of this module: overlap is the constraint's question, not this
    // function's. If this ever returns "not_offered", someone has added an
    // Appointment lookup here and `lib/appointments/create.ts` now has a
    // check-then-write race in it.
    await db.insert(schema.appointments).values({
      businessId,
      serviceId,
      name: "Existing Customer",
      phoneE164: "+12025550101",
      startsAt: NINE_AM,
      endsAt: TEN_AM,
    });

    expect(await offered(NINE_AM)).toBe("offered");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- lib/availability/offered.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/availability/offered"`.

- [ ] **Step 3: Write the implementation**

Create `lib/availability/offered.ts`:

```ts
import { loadSchedule } from "@/lib/availability/schedule";
import { openSlots } from "@/lib/availability/slots";

/**
 * Does this Business offer a Slot starting at exactly this instant?
 *
 * **This function never looks at other Appointments, and must not start.**
 * Whether a Slot is already taken is settled by the `appointments_no_overlap`
 * EXCLUDE constraint when the insert is attempted — see
 * `lib/availability/book.ts`. Asking the same question here would be a
 * check-then-write, which SPEC.md §3 rule 8 exists to rule out: three
 * concurrent Agents all read "free" before any of them writes.
 *
 * What is left is the half the database cannot answer. `appointments_no_overlap`
 * compares time ranges and knows nothing about `business_hours`, so opening
 * hours and past times have to be checked in application code. There is no
 * constraint here to undermine.
 *
 * `not_offered` covers two cases on purpose: the Business is closed then, and
 * the time is inside opening hours but off the Slot grid — 09:07 when Slots run
 * 09:00, 10:00, 11:00. Both mean the same thing to the person: that is not a
 * time you can book.
 */

export type SlotOffer = "offered" | "not_offered" | "in_the_past";

export type SlotIsOfferedInput = {
  businessId: string;
  serviceId: string;
  startsAt: Date;
  /** Injected rather than read, so callers and tests can pin it. */
  now?: Date;
};

export async function slotIsOffered({
  businessId,
  serviceId,
  startsAt,
  now = new Date(),
}: SlotIsOfferedInput): Promise<SlotOffer> {
  /*
    Checked before generating anything. `openSlots` refuses to return a Slot
    before `now`, so a past time would come back as an empty list and be
    indistinguishable from "you are closed then" — two different sentences for
    the person to read.
  */
  if (startsAt.getTime() < now.getTime()) return "in_the_past";

  const { timezone, durationMinutes, hours } = await loadSchedule({
    businessId,
    serviceId,
  });

  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);

  const candidates = openSlots({
    hours,
    timezone,
    durationMinutes,
    // Never anything else. See this module's header.
    busy: [],
    /*
      A window exactly one Slot wide. `from` drops any Slot starting earlier and
      `to` drops any Slot ending later, so the only Slot that can survive is one
      that begins at exactly `startsAt` — which is also what makes an off-grid
      time fall out.
    */
    from: startsAt,
    to: endsAt,
    now,
  });

  return candidates.length === 1 ? "offered" : "not_offered";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- lib/availability/offered.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/availability/offered.ts lib/availability/offered.test.ts
git commit -m "Answer only the half of bookability the constraint cannot"
```

---

## Task 4: createAppointment

**Files:**
- Create: `lib/appointments/create.ts`
- Test: `lib/appointments/create.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/appointments/create.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAppointment } from "@/lib/appointments/create";
import { provisionUser } from "@/lib/auth/provision-user";
import { db, schema } from "@/lib/db";

const CLERK_ID = "user_test_appointments_create";
const TIMEZONE = "Asia/Kolkata";

const NOW = new Date("2026-08-16T00:00:00.000Z");
// 09:00 Asia/Kolkata (+05:30) on Monday 17 August.
const NINE_AM = new Date("2026-08-17T03:30:00.000Z");
// 03:00 local on an open day.
const THREE_AM = new Date("2026-08-16T21:30:00.000Z");
// The Monday a week before NOW.
const LAST_MONDAY = new Date("2026-08-10T03:30:00.000Z");

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
    await db
      .delete(schema.services)
      .where(eq(schema.services.businessId, business.id));
    await db
      .delete(schema.businessHours)
      .where(eq(schema.businessHours.businessId, business.id));
    await db.delete(schema.businesses).where(eq(schema.businesses.id, business.id));
  }
  await db.delete(schema.users).where(eq(schema.users.clerkId, CLERK_ID));
}

beforeEach(async () => {
  await cleanup();
  const user = await provisionUser(CLERK_ID, "create@example.com");

  const [business] = await db
    .insert(schema.businesses)
    .values({
      userId: user.id,
      name: "Create Test Salon",
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

function create(startsAt: Date, name = "Priya Sharma") {
  return createAppointment({
    businessId,
    serviceId,
    name,
    phoneE164: "+919820012345",
    startsAt,
    now: NOW,
  });
}

describe("createAppointment", () => {
  it("creates into an open Slot, with ends_at derived from the duration", async () => {
    const result = await create(NINE_AM);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appointment.startsAt.toISOString()).toBe(
      "2026-08-17T03:30:00.000Z",
    );
    // 60-minute Service, so an hour later. Never accepted from the caller.
    expect(result.appointment.endsAt.toISOString()).toBe(
      "2026-08-17T04:30:00.000Z",
    );
    expect(result.appointment.status).toBe("pending");
  });

  it("refuses a time when the Business is closed", async () => {
    expect(await create(THREE_AM)).toEqual({ ok: false, reason: "not_offered" });
  });

  it("refuses a time that has already passed", async () => {
    expect(await create(LAST_MONDAY)).toEqual({
      ok: false,
      reason: "in_the_past",
    });
  });

  it("refuses a Slot another Appointment already holds", async () => {
    expect((await create(NINE_AM)).ok).toBe(true);

    expect(await create(NINE_AM, "Daniel Okafor")).toEqual({
      ok: false,
      reason: "slot_taken",
    });
  });

  it("lets exactly one of two concurrent creates win the same Slot", async () => {
    /*
      The test that protects the design. It is not a duplicate of
      lib/availability/book.test.ts: that one proves the constraint holds at the
      database level, this one proves the layer above does not route around it.

      A pre-check added to createAppointment would let both calls read "free"
      before either wrote, and both would be reported as created — so this fails
      the moment someone reintroduces one.
    */
    const results = await Promise.all([
      create(NINE_AM, "Priya Sharma"),
      create(NINE_AM, "Daniel Okafor"),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "slot_taken")).toHaveLength(
      1,
    );

    const rows = await db
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.businessId, businessId));
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- lib/appointments/create.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/appointments/create"`.

- [ ] **Step 3: Write the implementation**

Create `lib/appointments/create.ts`:

```ts
import { bookSlot } from "@/lib/availability/book";
import { slotIsOffered } from "@/lib/availability/offered";
import type { schema } from "@/lib/db";

/**
 * Create an Appointment by hand, from the Overview quick-add card (issue #7).
 *
 * Two steps, with two different owners, and keeping them apart is the whole
 * point of this file:
 *
 * 1. `slotIsOffered` — is the Business open then, and is the time still ahead?
 *    Postgres cannot answer this: `appointments_no_overlap` compares time
 *    ranges and never sees `business_hours`.
 *
 * 2. `bookSlot` — attempt the insert. If the Slot is taken, the constraint
 *    rejects it and `bookSlot` hands that back as `slot_taken`.
 *
 * **Nothing here asks whether the Slot is free before inserting, and nothing
 * should be added that does.** Such a check cannot prevent the race it appears
 * to prevent — SPEC.md §5 permits three concurrent Agents, and three
 * check-then-write sequences find any gap between the read and the write. Worse,
 * it would make the `slot_taken` branch below look redundant, and deleting that
 * branch is how the constraint gets orphaned.
 *
 * This function is thin on purpose. The behaviour lives in the two functions it
 * calls; what it adds is a name for each refusal, so the card can say what went
 * wrong instead of showing a generic error.
 */

export type Appointment = typeof schema.appointments.$inferSelect;

export type CreateAppointmentInput = {
  businessId: string;
  serviceId: string;
  name: string;
  /** E.164, already validated by `lib/appointments/phone.ts`. */
  phoneE164: string;
  startsAt: Date;
  /** Injected rather than read, so callers and tests can pin it. */
  now?: Date;
};

export type CreateAppointmentResult =
  | { ok: true; appointment: Appointment }
  | { ok: false; reason: "not_offered" | "in_the_past" | "slot_taken" };

export async function createAppointment({
  businessId,
  serviceId,
  name,
  phoneE164,
  startsAt,
  now = new Date(),
}: CreateAppointmentInput): Promise<CreateAppointmentResult> {
  const offer = await slotIsOffered({ businessId, serviceId, startsAt, now });
  if (offer !== "offered") {
    return { ok: false, reason: offer };
  }

  const booked = await bookSlot({
    businessId,
    serviceId,
    name,
    phoneE164,
    startsAt,
  });
  if (!booked.ok) {
    return { ok: false, reason: "slot_taken" };
  }

  return { ok: true, appointment: booked.appointment };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- lib/appointments/create.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/appointments/create.ts lib/appointments/create.test.ts
git commit -m "Create an Appointment, naming each refusal without deciding it"
```

---

## Task 5: Quick-add form parsing

**Files:**
- Create: `lib/appointments/quick-add-input.ts`
- Test: `lib/appointments/quick-add-input.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/appointments/quick-add-input.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { parseQuickAddInput } from "@/lib/appointments/quick-add-input";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

const VALID = {
  name: "Priya Sharma",
  phone: "+91 98200 12345",
  serviceId: "6f2a1c4e-0000-4000-8000-000000000001",
  startsAt: "2026-08-17T03:30:00.000Z",
};

describe("parseQuickAddInput", () => {
  it("accepts a filled form and normalises the phone number", () => {
    const parsed = parseQuickAddInput(form(VALID));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.name).toBe("Priya Sharma");
    expect(parsed.value.phoneE164).toBe("+919820012345");
    expect(parsed.value.serviceId).toBe(VALID.serviceId);
    expect(parsed.value.startsAt.toISOString()).toBe("2026-08-17T03:30:00.000Z");
  });

  it("reports every empty field at once, not one per round trip", () => {
    const parsed = parseQuickAddInput(form({}));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual({
      name: "Enter the person's name.",
      phone: "Enter a phone number.",
      serviceId: "Choose a service.",
      startsAt: "Choose a time.",
    });
  });

  it("echoes the submission back so a rejected form repopulates", () => {
    const parsed = parseQuickAddInput(form({ ...VALID, phone: "9820012345" }));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.values).toEqual({
      name: "Priya Sharma",
      phone: "9820012345",
      serviceId: VALID.serviceId,
      startsAt: VALID.startsAt,
    });
  });

  it("passes the phone validator's own message through", () => {
    const parsed = parseQuickAddInput(form({ ...VALID, phone: "9820012345" }));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.phone).toBe(
      "Start with the country code, like +44 or +91.",
    );
  });

  it("rejects a time that is not an instant, rather than throwing", () => {
    const parsed = parseQuickAddInput(form({ ...VALID, startsAt: "tomorrow" }));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.startsAt).toBe("Choose a time from the list.");
  });

  it("rejects a name longer than the ceiling", () => {
    const parsed = parseQuickAddInput(form({ ...VALID, name: "a".repeat(81) }));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.name).toBe("Keep the name under 80 characters.");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- lib/appointments/quick-add-input.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/appointments/quick-add-input"`.

- [ ] **Step 3: Write the implementation**

Create `lib/appointments/quick-add-input.ts`:

```ts
import { parseE164 } from "@/lib/appointments/phone";
import { field } from "@/lib/form-field";

/**
 * Validation for the four fields the Overview quick-add card carries.
 *
 * Shaped like `lib/settings/services-input.ts` and for the same reasons: a
 * `parse*` returning a discriminated result, hand-written rather than zod, with
 * the state types beside it because a `"use server"` module may export nothing
 * but async functions.
 *
 * A Server Action is a POST reachable by anyone who can send it
 * (`node_modules/next/dist/docs/01-app/02-guides/server-actions.md`,
 * "Security"), so nothing here assumes the request came from the rendered card.
 * `serviceId` arrives as an opaque string and is deliberately not trusted:
 * whether that Service exists and belongs to this Business is settled against
 * the database in `lib/availability/schedule.ts`, never here.
 */

/**
 * Longest name accepted. An application rule, not a column constraint:
 * `appointments.name` is plain `text`. The name is read aloud by the Retell
 * Agent and rendered in a table cell, so it needs a ceiling somewhere.
 */
export const MAX_NAME_LENGTH = 80;

export type QuickAddErrors = {
  name?: string;
  phone?: string;
  serviceId?: string;
  startsAt?: string;
  /**
   * Not attributable to a field — the Service vanished, or the write was
   * refused for a reason no single input caused. Rendered above the form.
   */
  form?: string;
};

/** Echoed back so a rejected submit repopulates instead of clearing. */
export type QuickAddValues = {
  name?: string;
  phone?: string;
  serviceId?: string;
  startsAt?: string;
};

export type QuickAddState = {
  errors?: QuickAddErrors;
  values?: QuickAddValues;
  /**
   * A successful write. Distinct from "no errors": the initial state has no
   * errors either, and the card must not announce an Appointment that was never
   * created.
   */
  added?: { name: string; startsAt: string };
};

export const INITIAL_QUICK_ADD_STATE: QuickAddState = {};

export type QuickAddInput = {
  name: string;
  phoneE164: string;
  serviceId: string;
  startsAt: Date;
};

export type ParsedQuickAddInput =
  | { ok: true; value: QuickAddInput }
  | { ok: false; errors: QuickAddErrors; values: QuickAddValues };

export function parseQuickAddInput(formData: FormData): ParsedQuickAddInput {
  const rawName = field(formData, "name");
  const rawPhone = field(formData, "phone");
  const rawServiceId = field(formData, "serviceId");
  const rawStartsAt = field(formData, "startsAt");

  const errors: QuickAddErrors = {};

  const name = rawName.trim();
  if (name.length === 0) {
    errors.name = "Enter the person's name.";
  } else if (name.length > MAX_NAME_LENGTH) {
    errors.name = `Keep the name under ${MAX_NAME_LENGTH} characters.`;
  }

  // The phone validator owns its own wording, so a bad number reads the same
  // here as it will in #8's per-row CSV report.
  const phone = parseE164(rawPhone);
  if (!phone.ok) {
    errors.phone = phone.error;
  }

  const serviceId = rawServiceId.trim();
  if (serviceId.length === 0) {
    errors.serviceId = "Choose a service.";
  }

  const rawTime = rawStartsAt.trim();
  let startsAt = new Date(Number.NaN);
  if (rawTime.length === 0) {
    errors.startsAt = "Choose a time.";
  } else {
    startsAt = new Date(rawTime);
    if (Number.isNaN(startsAt.getTime())) {
      // The card's `<option value>` is an ISO instant. Anything else was not
      // sent by the card, and is a field error rather than a 500.
      errors.startsAt = "Choose a time from the list.";
    }
  }

  // Every field is reported at once. Returning only the first would make a form
  // with two problems take two round trips to fix.
  if (Object.keys(errors).length > 0) {
    return {
      ok: false,
      errors,
      values: {
        name: rawName,
        phone: rawPhone,
        serviceId: rawServiceId,
        startsAt: rawStartsAt,
      },
    };
  }

  return {
    ok: true,
    // Narrowed by the checks above: `phone.ok` is true or `errors.phone` was set.
    value: {
      name,
      phoneE164: (phone as { ok: true; value: string }).value,
      serviceId,
      startsAt,
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- lib/appointments/quick-add-input.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/appointments/quick-add-input.ts lib/appointments/quick-add-input.test.ts
git commit -m "Parse the quick-add form, reporting all four fields at once"
```

---

## Task 6: listAppointments — rename, attempts and the last Call

**Files:**
- Modify: `lib/business/list-appointments.ts` (whole file)
- Modify: `app/(app)/settings/actions.ts:5` and `:101`
- Modify: `app/(app)/page.tsx:2` and `:18`
- Test: `lib/business/list-appointments.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/business/list-appointments.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { provisionUser } from "@/lib/auth/provision-user";
import { listAppointments } from "@/lib/business/list-appointments";
import { db, schema } from "@/lib/db";

const CLERK_ID = "user_test_list_appointments";

const NINE_AM = new Date("2026-08-17T03:30:00.000Z");
const TEN_AM = new Date("2026-08-17T04:30:00.000Z");
const ELEVEN_AM = new Date("2026-08-17T05:30:00.000Z");
const NOON = new Date("2026-08-17T06:30:00.000Z");

let businessId: string;
let serviceId: string;
let appointmentId: string;

async function cleanup() {
  const user = await db.query.users.findFirst({
    where: eq(schema.users.clerkId, CLERK_ID),
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
      await db
        .delete(schema.calls)
        .where(eq(schema.calls.appointmentId, appointment.id));
    }
    await db
      .delete(schema.appointments)
      .where(eq(schema.appointments.businessId, business.id));
    await db
      .delete(schema.services)
      .where(eq(schema.services.businessId, business.id));
    await db.delete(schema.businesses).where(eq(schema.businesses.id, business.id));
  }
  await db.delete(schema.users).where(eq(schema.users.clerkId, CLERK_ID));
}

beforeEach(async () => {
  await cleanup();
  const user = await provisionUser(CLERK_ID, "list@example.com");

  const [business] = await db
    .insert(schema.businesses)
    .values({
      userId: user.id,
      name: "List Test Salon",
      businessType: "salon",
      timezone: "Asia/Kolkata",
    })
    .returning();
  businessId = business.id;

  const [service] = await db
    .insert(schema.services)
    .values({ businessId, name: "Haircut", durationMinutes: 60 })
    .returning();
  serviceId = service.id;

  const [appointment] = await db
    .insert(schema.appointments)
    .values({
      businessId,
      serviceId,
      name: "Priya Sharma",
      phoneE164: "+919820012345",
      startsAt: NINE_AM,
      endsAt: TEN_AM,
    })
    .returning();
  appointmentId = appointment.id;
});

afterEach(cleanup);

describe("listAppointments", () => {
  it("joins the Service name and reports no Calls yet", async () => {
    const [row] = await listAppointments(businessId);

    expect(row.name).toBe("Priya Sharma");
    expect(row.serviceName).toBe("Haircut");
    expect(row.attempts).toBe(0);
    expect(row.lastCallId).toBeNull();
  });

  it("counts attempts and points at the latest Call", async () => {
    const [first] = await db
      .insert(schema.calls)
      .values({ appointmentId, callType: "web", attempt: 1, status: "no_answer" })
      .returning();
    const [second] = await db
      .insert(schema.calls)
      .values({ appointmentId, callType: "web", attempt: 2, status: "completed" })
      .returning();

    const [row] = await listAppointments(businessId);

    expect(row.attempts).toBe(2);
    expect(row.lastCallId).toBe(second.id);
    expect(row.lastCallId).not.toBe(first.id);
  });

  it("returns Appointments earliest first", async () => {
    await db.insert(schema.appointments).values({
      businessId,
      serviceId,
      name: "Daniel Okafor",
      phoneE164: "+12025550143",
      startsAt: ELEVEN_AM,
      endsAt: NOON,
    });

    const rows = await listAppointments(businessId);

    expect(rows.map((r) => r.name)).toEqual(["Priya Sharma", "Daniel Okafor"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- lib/business/list-appointments.test.ts`
Expected: FAIL — `listAppointments is not a function` (the module exports `listUpcomingAppointments`).

- [ ] **Step 3: Rewrite list-appointments.ts**

Replace the whole of `lib/business/list-appointments.ts`:

```ts
import { asc, eq, inArray } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type { AppointmentStatus } from "@/lib/db/schema";

/**
 * The Appointments Overview renders.
 *
 * An explicit `innerJoin` rather than `db.query.appointments.findMany({ with:
 * { service: true } })`, because **no `relations()` are declared anywhere in
 * this repo** — `lib/db/schema.ts` wires tables together with FK
 * `.references()` only, and the relational query API needs more than that.
 * Adding `relations()` is a schema-wide convention change with its own
 * trade-offs, not something to slip into a feature ticket.
 *
 * Returns a narrow row rather than the table's own shape: a Server Action's and
 * a Server Component's output both cross to the client, and neither should
 * carry columns the UI does not render.
 *
 * **Named `listAppointments`, not `listUpcomingAppointments`.** There is no
 * time filter here and there never was — the old name described behaviour the
 * function did not have, and Settings was already relying on getting past rows
 * back when it checked newly narrowed hours for conflicts.
 */

export type AppointmentRow = {
  id: string;
  name: string;
  phoneE164: string;
  serviceName: string;
  startsAt: Date;
  endsAt: Date;
  status: AppointmentStatus;
  /** How many Calls have been placed for this Appointment. */
  attempts: number;
  /** The most recent Call, or null if none has been placed. */
  lastCallId: string | null;
};

export async function listAppointments(
  businessId: string,
  limit = 20,
): Promise<AppointmentRow[]> {
  const appointments = await db
    .select({
      id: schema.appointments.id,
      name: schema.appointments.name,
      phoneE164: schema.appointments.phoneE164,
      serviceName: schema.services.name,
      startsAt: schema.appointments.startsAt,
      endsAt: schema.appointments.endsAt,
      status: schema.appointments.status,
    })
    .from(schema.appointments)
    .innerJoin(
      schema.services,
      eq(schema.appointments.serviceId, schema.services.id),
    )
    .where(eq(schema.appointments.businessId, businessId))
    // Covered by `appointments_business_id_starts_at_idx`.
    .orderBy(asc(schema.appointments.startsAt))
    .limit(limit);

  if (appointments.length === 0) return [];

  /*
    A second query, folded in with JavaScript, rather than a lateral join or a
    window function.

    `businesses.call_quota` defaults to 5, so an account holds at most five
    `calls` rows in total — "load every Call for these Appointments" is bounded
    by the quota, not by the table. A DISTINCT ON would be more SQL to read for
    no measurable gain at that size.
  */
  const calls = await db
    .select({
      id: schema.calls.id,
      appointmentId: schema.calls.appointmentId,
      attempt: schema.calls.attempt,
    })
    .from(schema.calls)
    .where(
      inArray(
        schema.calls.appointmentId,
        appointments.map((a) => a.id),
      ),
    );

  const summaries = new Map<string, { attempts: number; last: { id: string; attempt: number } }>();
  for (const call of calls) {
    const found = summaries.get(call.appointmentId);
    if (!found) {
      summaries.set(call.appointmentId, {
        attempts: 1,
        last: { id: call.id, attempt: call.attempt },
      });
      continue;
    }
    found.attempts += 1;
    // Highest attempt number wins. A second Call is attempt 2 by definition
    // (SPEC.md §5), so this orders them without needing a timestamp.
    if (call.attempt > found.last.attempt) {
      found.last = { id: call.id, attempt: call.attempt };
    }
  }

  return appointments.map((appointment) => {
    const summary = summaries.get(appointment.id);
    return {
      ...appointment,
      attempts: summary?.attempts ?? 0,
      lastCallId: summary?.last.id ?? null,
    };
  });
}
```

- [ ] **Step 4: Add the Services read Overview needs**

Create `lib/business/list-services.ts`:

```ts
import { asc, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/**
 * The Services the quick-add card offers in its picker.
 *
 * Separate from `lib/settings/load-settings.ts`, which returns the same rows
 * plus an `appointmentCount` per Service — a count Settings needs to explain why
 * a Service cannot be deleted, and an extra query per Service that Overview
 * would pay for and never render.
 */

export type ServiceOption = {
  id: string;
  name: string;
  durationMinutes: number;
};

export async function listServices(
  businessId: string,
): Promise<ServiceOption[]> {
  return db
    .select({
      id: schema.services.id,
      name: schema.services.name,
      durationMinutes: schema.services.durationMinutes,
    })
    .from(schema.services)
    .where(eq(schema.services.businessId, businessId))
    // Stable order, so the picker's first Service — the one whose Slots the
    // page pre-loads — does not change between renders.
    .orderBy(asc(schema.services.createdAt), asc(schema.services.id));
}
```

- [ ] **Step 5: Update the two `listUpcomingAppointments` call sites**

In `app/(app)/settings/actions.ts`, change the import on line 5 and the call inside `saveBusinessHoursAction`:

```ts
import { listAppointments } from "@/lib/business/list-appointments";
```

```ts
  const appointments = await listAppointments(business.id, CONFLICT_SCAN_LIMIT);
```

In `app/(app)/page.tsx`, change the import and the call:

```ts
import { listAppointments } from "@/lib/business/list-appointments"
```

```ts
  const appointments = await listAppointments(business.id)
```

- [ ] **Step 6: Run the tests and the type checker**

Run: `npm test -- lib/business/list-appointments.test.ts`
Expected: PASS, 3 tests.

Run: `npm run typecheck`
Expected: no output, exit 0. This is what proves no other call site was missed.

- [ ] **Step 7: Commit**

```bash
git add lib/business/list-appointments.ts lib/business/list-appointments.test.ts lib/business/list-services.ts app/\(app\)/settings/actions.ts app/\(app\)/page.tsx
git commit -m "Give the list its attempts and last Call, and a name that is true"
```

---

## Task 7: The stat strip's four numbers

**Files:**
- Create: `lib/business/appointment-stats.ts`
- Test: `lib/business/appointment-stats.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/business/appointment-stats.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { provisionUser } from "@/lib/auth/provision-user";
import { appointmentStats } from "@/lib/business/appointment-stats";
import { db, schema } from "@/lib/db";

const CLERK_ID = "user_test_appointment_stats";

const NINE_AM = new Date("2026-08-17T03:30:00.000Z");
const TEN_AM = new Date("2026-08-17T04:30:00.000Z");
const ELEVEN_AM = new Date("2026-08-17T05:30:00.000Z");
const NOON = new Date("2026-08-17T06:30:00.000Z");

let businessId: string;
let serviceId: string;
let firstAppointmentId: string;

async function cleanup() {
  const user = await db.query.users.findFirst({
    where: eq(schema.users.clerkId, CLERK_ID),
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
      await db
        .delete(schema.calls)
        .where(eq(schema.calls.appointmentId, appointment.id));
    }
    await db
      .delete(schema.appointments)
      .where(eq(schema.appointments.businessId, business.id));
    await db
      .delete(schema.services)
      .where(eq(schema.services.businessId, business.id));
    await db.delete(schema.businesses).where(eq(schema.businesses.id, business.id));
  }
  await db.delete(schema.users).where(eq(schema.users.clerkId, CLERK_ID));
}

beforeEach(async () => {
  await cleanup();
  const user = await provisionUser(CLERK_ID, "stats@example.com");

  const [business] = await db
    .insert(schema.businesses)
    .values({
      userId: user.id,
      name: "Stats Test Salon",
      businessType: "salon",
      timezone: "Asia/Kolkata",
    })
    .returning();
  businessId = business.id;

  const [service] = await db
    .insert(schema.services)
    .values({ businessId, name: "Haircut", durationMinutes: 60 })
    .returning();
  serviceId = service.id;

  const [first] = await db
    .insert(schema.appointments)
    .values({
      businessId,
      serviceId,
      name: "Priya Sharma",
      phoneE164: "+919820012345",
      startsAt: NINE_AM,
      endsAt: TEN_AM,
      status: "confirmed",
    })
    .returning();
  firstAppointmentId = first.id;

  await db.insert(schema.appointments).values({
    businessId,
    serviceId,
    name: "Daniel Okafor",
    phoneE164: "+12025550143",
    startsAt: ELEVEN_AM,
    endsAt: NOON,
    status: "pending",
  });
});

afterEach(cleanup);

describe("appointmentStats", () => {
  it("counts every Appointment, not only the ones still ahead", async () => {
    const stats = await appointmentStats(businessId);

    expect(stats.total).toBe(2);
    expect(stats.confirmed).toBe(1);
  });

  it("reads Answer rate as null when no Call has been placed", async () => {
    // A fresh account. Rendering 0% would claim a dialler had tried and failed.
    expect((await appointmentStats(businessId)).answerRate).toBeNull();
  });

  it("counts Needs attention from the reason, not the status", async () => {
    // SPEC.md §5: the reason is orthogonal to status. This row is confirmed
    // AND collided, and must be counted.
    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: "collision" })
      .where(eq(schema.appointments.id, firstAppointmentId));

    const stats = await appointmentStats(businessId);

    expect(stats.needsAttention).toBe(1);
    expect(stats.confirmed).toBe(1);
  });

  it("divides completed Calls by Calls that left the queue", async () => {
    await db.insert(schema.calls).values([
      {
        appointmentId: firstAppointmentId,
        callType: "web",
        attempt: 1,
        status: "no_answer",
      },
      {
        appointmentId: firstAppointmentId,
        callType: "web",
        attempt: 2,
        status: "completed",
      },
      // Still queued — not yet an attempt at anything, so not in the divisor.
      {
        appointmentId: firstAppointmentId,
        callType: "web",
        attempt: 3,
        status: "queued",
      },
    ]);

    expect((await appointmentStats(businessId)).answerRate).toBe(0.5);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- lib/business/appointment-stats.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/business/appointment-stats"`.

- [ ] **Step 3: Write the implementation**

Create `lib/business/appointment-stats.ts`:

```ts
import { eq, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/**
 * The four numbers in Overview's stat strip (SPEC.md §11.3).
 *
 * Two aggregates rather than one query with a join, because joining
 * `appointments` to `calls` multiplies the Appointment rows by their Calls and
 * every count on the Appointment side would then be wrong.
 *
 * Counted over **every** Appointment the Business has, not only the ones still
 * ahead. The seeded demo rows age past their start time within days, and a
 * strip that emptied itself as they did would make a returning demo account
 * look broken.
 */

export type AppointmentStats = {
  total: number;
  confirmed: number;
  needsAttention: number;
  /**
   * Completed Calls over Calls that left the queue.
   *
   * `null`, not 0, when no Call has ever been placed — which is every account
   * until #11 lands. The strip renders null as "—". Showing 0% would claim a
   * dialler had tried and failed.
   */
  answerRate: number | null;
};

export async function appointmentStats(
  businessId: string,
): Promise<AppointmentStats> {
  /*
    `count(*) FILTER (WHERE ...)` is Postgres's conditional count. The `::int`
    casts are load-bearing: `count()` returns `bigint`, which `pg` hands back as
    a *string* to avoid losing precision, and a string would flow all the way
    into the rendered tile. The extra parentheses are needed because `::` binds
    tighter than the FILTER clause.
  */
  const [counts] = await db
    .select({
      total: sql<number>`(count(*))::int`,
      confirmed: sql<number>`(count(*) filter (where ${schema.appointments.status} = 'confirmed'))::int`,
      // From the reason, never the status. SPEC.md §5 makes the two orthogonal:
      // an Appointment can be confirmed *and* collided.
      needsAttention: sql<number>`(count(*) filter (where ${schema.appointments.needsAttentionReason} is not null))::int`,
    })
    .from(schema.appointments)
    .where(eq(schema.appointments.businessId, businessId));

  const [calls] = await db
    .select({
      placed: sql<number>`(count(*) filter (where ${schema.calls.status} <> 'queued'))::int`,
      answered: sql<number>`(count(*) filter (where ${schema.calls.status} = 'completed'))::int`,
    })
    .from(schema.calls)
    // Scoped through the Appointment, because `calls` carries no business_id.
    .innerJoin(
      schema.appointments,
      eq(schema.calls.appointmentId, schema.appointments.id),
    )
    .where(eq(schema.appointments.businessId, businessId));

  return {
    total: counts.total,
    confirmed: counts.confirmed,
    needsAttention: counts.needsAttention,
    answerRate: calls.placed === 0 ? null : calls.answered / calls.placed,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- lib/business/appointment-stats.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/business/appointment-stats.ts lib/business/appointment-stats.test.ts
git commit -m "Count the stat strip's four numbers, with Answer rate honest at null"
```

---

## Task 8: The Server Actions

No test file. These are thin wrappers over functions already tested in Tasks 4–7, and they call `requireBusiness()`, which needs a Clerk session that the Vitest harness has no way to produce. Task 14's manual check exercises them.

**Files:**
- Create: `app/(app)/actions.ts`

- [ ] **Step 1: Write the actions**

Create `app/(app)/actions.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";

import { createAppointment } from "@/lib/appointments/create";
import {
  parseQuickAddInput,
  type QuickAddState,
} from "@/lib/appointments/quick-add-input";
import { findAvailableSlots } from "@/lib/availability/find";
import { requireBusiness } from "@/lib/business/require-business";
import { formatInZone } from "@/lib/time/zone";

/**
 * Overview's two Server Actions — the quick-add write, and the Slot list the
 * card re-reads when the Service changes.
 *
 * The three rules `app/(app)/settings/actions.ts` documents hold here too:
 * `requireBusiness()` comes first always, because a Server Action is a POST
 * reachable by anyone who can send it and rendering the card on an
 * authenticated screen is not a security boundary; nothing closes over
 * anything; and a rejected write returns state rather than throwing, because
 * SPEC.md §11.4 wants inline persistent UI for anything requiring action.
 */

/**
 * How far ahead the Slot picker looks, and how many options it will render.
 *
 * Fourteen days so a Business open two days a week still has something to
 * offer. Fifty options because past that a `<select>` stops being usable — a
 * presentation bound, not a correctness one, and the list is truncated from the
 * far end so the soonest Slots always survive.
 */
const HORIZON_DAYS = 14;
const MAX_SLOT_OPTIONS = 50;

const DAY_MS = 86_400_000;

/** One entry in the time picker. `value` is an ISO instant; `label` is local. */
export type SlotOption = { value: string; label: string };

export async function addAppointmentAction(
  _previous: QuickAddState,
  formData: FormData,
): Promise<QuickAddState> {
  const { business } = await requireBusiness();

  const parsed = parseQuickAddInput(formData);
  if (!parsed.ok) {
    return { errors: parsed.errors, values: parsed.values };
  }

  const result = await createAppointment({
    businessId: business.id,
    serviceId: parsed.value.serviceId,
    name: parsed.value.name,
    phoneE164: parsed.value.phoneE164,
    startsAt: parsed.value.startsAt,
  });

  if (!result.ok) {
    // Every refusal lands on the time field, because the time is the only thing
    // the person can change to fix any of them.
    return {
      errors: { startsAt: REFUSALS[result.reason] },
      values: {
        name: parsed.value.name,
        phone: parsed.value.phoneE164,
        serviceId: parsed.value.serviceId,
        startsAt: parsed.value.startsAt.toISOString(),
      },
    };
  }

  /*
    This one line is the whole of "appears in the table without a manual
    refresh". Next re-runs the page's Server Component once the action resolves,
    so the table, the stat strip and the Slot options all come back fresh
    together — there is no client-side cache to reconcile and nothing to poll.
  */
  revalidatePath("/");

  return {
    added: {
      name: result.appointment.name,
      startsAt: formatInZone(result.appointment.startsAt, business.timezone),
    },
  };
}

/**
 * The messages behind `createAppointment`'s three refusals.
 *
 * `slot_taken` is worded for the race it describes. The picker only ever offers
 * open Slots, so the ordinary way to reach it is someone else booking the same
 * Slot between the page rendering and this submit.
 */
const REFUSALS: Record<"not_offered" | "in_the_past" | "slot_taken", string> = {
  not_offered: "That is not a time you can book. Pick one from the list.",
  in_the_past: "That time has already passed.",
  slot_taken: "Someone just booked that time. Pick another.",
};

/**
 * The open Slots for one Service, for the time picker.
 *
 * A read rather than a write, and an action rather than data loaded with the
 * page, because Slot size is the Service duration: one Service's Slots cannot
 * be reused for another. Settings lets a Business add Services without limit, so
 * pre-computing all of them would make page load cost grow with the Service
 * count. One Availability run per page load and one per Service change does not.
 */
export async function slotOptionsAction(
  serviceId: string,
): Promise<SlotOption[]> {
  const { business } = await requireBusiness();

  const now = new Date();
  const slots = await findAvailableSlots({
    businessId: business.id,
    // Scoped inside `loadSchedule`: a Service id belonging to another Business
    // does not resolve, so this throws rather than reading someone else's
    // Availability.
    serviceId,
    from: now,
    to: new Date(now.getTime() + HORIZON_DAYS * DAY_MS),
    now,
  });

  return slots.slice(0, MAX_SLOT_OPTIONS).map((slot) => ({
    value: slot.startsAt.toISOString(),
    label: formatInZone(slot.startsAt, business.timezone),
  }));
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/\(app\)/actions.ts
git commit -m "Add Overview's two Server Actions — the quick-add and the Slot read"
```

---

## Task 9: Move FieldError out of settings

**Files:**
- Create: `components/ui/field-error.tsx`
- Modify: `components/settings/section.tsx:110-117` (delete `FieldError`)
- Modify: every settings component that imports `FieldError`

- [ ] **Step 1: Create the shared component**

Create `components/ui/field-error.tsx`:

```tsx
/**
 * The message under an input that a field-level validation error produces.
 *
 * Lived in `components/settings/section.tsx` until Overview's quick-add card
 * needed the same seven lines. Overview should not import from settings, and a
 * second copy would be a second place for the colour to drift, so it moved
 * here. `SettingsSection` and `SettingsCallout` stayed — those are genuinely
 * settings-shaped.
 *
 * Renders nothing when there is no message, so a caller can pass a possibly
 * undefined error without guarding first.
 */
export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null
  return (
    <p id={id} className="text-table text-declined">
      {message}
    </p>
  )
}
```

- [ ] **Step 2: Delete it from section.tsx**

In `components/settings/section.tsx`, delete the `FieldError` function (lines 110–117).

- [ ] **Step 3: Repoint every importer**

Run: `grep -rn "FieldError" components/ app/ --include=*.tsx`

For each file that imports `FieldError` from `@/components/settings/section`, remove it from that import and add:

```tsx
import { FieldError } from "@/components/ui/field-error"
```

- [ ] **Step 4: Verify nothing broke**

Run: `npm run typecheck`
Expected: no output, exit 0. A missed importer fails here.

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add components/ui/field-error.tsx components/settings/
git commit -m "Move FieldError to components/ui, where Overview can reach it"
```

---

## Task 10: The status pill

**Files:**
- Create: `components/overview/status-pill.tsx`

- [ ] **Step 1: Write the component**

Create `components/overview/status-pill.tsx`:

```tsx
import type { AppointmentStatus } from "@/lib/db/schema"

/**
 * An Appointment's status as a coloured dot plus a label (SPEC.md §11.2).
 *
 * Every colour below is a token already declared in `app/globals.css`. This
 * component introduces none — the `--color-*: initial` reset in that file means
 * an off-token colour would not compile.
 *
 * **§11.2 names colours for five statuses and the schema has seven**, so two
 * were decided here and are written down so the next screen that needs a pill
 * does not re-derive them differently:
 *
 * - `pending` uses `text-muted`. Nothing has happened to this Appointment yet,
 *   and a status that is merely the default should not draw the eye.
 * - `cancelled` uses the `unreachable` slate rather than the `declined` red. A
 *   cancellation is a neutral outcome; red is reserved for the person saying no.
 *
 * A dot plus a word, never colour alone: about one in twelve men cannot
 * distinguish the green from the amber, and the label is what they read.
 */

const STATUS_STYLES: Record<
  AppointmentStatus,
  { dot: string; label: string }
> = {
  pending: { dot: "bg-text-muted", label: "Pending" },
  // §11.2: "in-progress uses accent".
  calling: { dot: "bg-accent", label: "Calling" },
  confirmed: { dot: "bg-confirmed", label: "Confirmed" },
  rescheduled: { dot: "bg-rescheduled", label: "Rescheduled" },
  declined: { dot: "bg-declined", label: "Declined" },
  cancelled: { dot: "bg-unreachable", label: "Cancelled" },
  unreachable: { dot: "bg-unreachable", label: "Unreachable" },
}

export function StatusPill({ status }: { status: AppointmentStatus }) {
  const style = STATUS_STYLES[status]

  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-line px-2 py-1 text-table text-text">
      <span className={`size-2 rounded-full ${style.dot}`} aria-hidden />
      {style.label}
    </span>
  )
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npm run typecheck`
Expected: no output, exit 0. `Record<AppointmentStatus, …>` fails here if a status is missing.

- [ ] **Step 3: Commit**

```bash
git add components/overview/status-pill.tsx
git commit -m "Render status as a dot and a label, with the two §11.2 leaves open"
```

---

## Task 11: The stat strip

**Files:**
- Create: `components/overview/stat-strip.tsx`

- [ ] **Step 1: Write the component**

Create `components/overview/stat-strip.tsx`:

```tsx
import type { AppointmentStats } from "@/lib/business/appointment-stats"

/**
 * Overview's four numbers (SPEC.md §11.3): Total · Confirmed · Needs attention
 * · Answer rate.
 *
 * A Server Component — it holds no state and reacts to nothing, and the numbers
 * arrive already counted.
 *
 * Numbers are mono per §11.2, which puts phone numbers, timestamps, durations
 * and Slot times in the mono face. Counts belong with them: the four tiles are
 * the same width whatever the digits, so the strip does not shift as it updates.
 */
export function StatStrip({ stats }: { stats: AppointmentStats }) {
  return (
    <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
      <Tile label="Total" value={String(stats.total)} />
      <Tile label="Confirmed" value={String(stats.confirmed)} />
      <Tile
        label="Needs attention"
        value={String(stats.needsAttention)}
        /*
          Coloured only when there is something to attend to. §11.2 gives this
          its own token precisely because four failure paths converge on it
          (§5) — but a zero rendered in alarm orange would cry wolf on every
          healthy account, including every freshly seeded one.
        */
        emphasis={stats.needsAttention > 0 ? "text-attention" : undefined}
      />
      <Tile
        label="Answer rate"
        /*
          "—" and not "0%". A fresh account has placed no Calls at all, and 0%
          would claim a dialler had tried and failed. #11 is what makes this a
          number.
        */
        value={
          stats.answerRate === null
            ? "—"
            : `${Math.round(stats.answerRate * 100)}%`
        }
      />
    </dl>
  )
}

function Tile({
  label,
  value,
  emphasis,
}: {
  label: string
  value: string
  emphasis?: string
}) {
  return (
    <div className="flex flex-col gap-1 rounded-card border border-line bg-surface p-4">
      <dt className="text-table text-text-muted">{label}</dt>
      <dd className={`font-mono text-page ${emphasis ?? "text-text"}`}>
        {value}
      </dd>
    </div>
  )
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add components/overview/stat-strip.tsx
git commit -m "Add the stat strip, with Answer rate reading — until a Call exists"
```

---

## Task 12: The Quick Call card

**Files:**
- Create: `components/overview/quick-call-card.tsx`

- [ ] **Step 1: Write the component**

Create `components/overview/quick-call-card.tsx`:

```tsx
"use client"

import { Loader2 } from "lucide-react"
import * as React from "react"

import { useFormStatus } from "react-dom"

import {
  addAppointmentAction,
  slotOptionsAction,
  type SlotOption,
} from "@/app/(app)/actions"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field-error"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  INITIAL_QUICK_ADD_STATE,
  MAX_NAME_LENGTH,
} from "@/lib/appointments/quick-add-input"

/**
 * The Quick Call card (SPEC.md §11.3) — the demo path, and the only Client
 * Component on Overview.
 *
 * **The button says "Add appointment", not "Call now".** §11.3 asks for "Call
 * now", and it will say that once #11 can place a Web Call — the dial chains
 * onto this same submit. Until then the verb would name something the button
 * does not do, which is the small version of the mistake SPEC.md §3 rule 7
 * treats as the most damaging failure available to this product.
 *
 * **The time picker offers only Slots Availability actually has open.** They
 * arrive from `slotOptionsAction`, which runs #6's engine. The list can still go
 * stale between render and submit, and that is what the "someone just booked
 * that time" refusal is for — the correct outcome, not a defect to design away.
 *
 * A native `<select>` rather than a combobox: `components/ui` has no Select, the
 * option lists are short, and a native control gets keyboard behaviour and
 * mobile pickers for free.
 */

type QuickCallCardProps = {
  services: { id: string; name: string; durationMinutes: number }[]
  /** The open Slots for `services[0]`, rendered on the server so the card is
   *  usable on first paint without a round trip. */
  initialSlots: SlotOption[]
  /** The Business's IANA zone — the label under the card, so times are unambiguous. */
  timezone: string
}

export function QuickCallCard({
  services,
  initialSlots,
  timezone,
}: QuickCallCardProps) {
  const [state, formAction] = React.useActionState(
    addAppointmentAction,
    INITIAL_QUICK_ADD_STATE,
  )

  const [serviceId, setServiceId] = React.useState(services[0]?.id ?? "")
  const [slots, setSlots] = React.useState(initialSlots)
  const [loadingSlots, startLoadingSlots] = React.useTransition()

  function changeService(nextServiceId: string) {
    setServiceId(nextServiceId)
    // Slot size is the Service duration, so the previous Service's times are
    // not merely stale — they are the wrong length. Cleared before the fetch so
    // no time from the old list can be submitted against the new Service.
    setSlots([])
    startLoadingSlots(async () => {
      setSlots(await slotOptionsAction(nextServiceId))
    })
  }

  return (
    <section className="rounded-card border border-accent bg-surface p-4">
      <div className="flex flex-col gap-1 pb-4">
        <h2 className="text-section font-semibold text-text">Quick call</h2>
        <p className="text-table text-text-muted">
          Times shown in {timezone}.
        </p>
      </div>

      <form action={formAction} className="flex flex-col gap-4">
        <FieldError id="quick-add-form-error" message={state.errors?.form} />

        <div className="grid gap-4 md:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="quick-add-name">Name</Label>
            <Input
              id="quick-add-name"
              name="name"
              maxLength={MAX_NAME_LENGTH}
              defaultValue={state.values?.name}
              aria-invalid={Boolean(state.errors?.name) || undefined}
              aria-describedby={
                state.errors?.name ? "quick-add-name-error" : undefined
              }
            />
            <FieldError id="quick-add-name-error" message={state.errors?.name} />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="quick-add-phone">Phone</Label>
            <Input
              id="quick-add-phone"
              name="phone"
              inputMode="tel"
              placeholder="+44 7700 900123"
              // Mono, per §11.2 — phone numbers are one of the faces it names.
              className="font-mono"
              defaultValue={state.values?.phone}
              aria-invalid={Boolean(state.errors?.phone) || undefined}
              aria-describedby={
                state.errors?.phone ? "quick-add-phone-error" : undefined
              }
            />
            <FieldError
              id="quick-add-phone-error"
              message={state.errors?.phone}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="quick-add-service">Service</Label>
            <select
              id="quick-add-service"
              name="serviceId"
              value={serviceId}
              onChange={(event) => changeService(event.target.value)}
              className="h-9 rounded-control border border-line bg-bg px-3 text-body text-text"
              aria-invalid={Boolean(state.errors?.serviceId) || undefined}
              aria-describedby={
                state.errors?.serviceId ? "quick-add-service-error" : undefined
              }
            >
              {services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name} · {service.durationMinutes} min
                </option>
              ))}
            </select>
            <FieldError
              id="quick-add-service-error"
              message={state.errors?.serviceId}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="quick-add-time">Time</Label>
            <select
              id="quick-add-time"
              name="startsAt"
              disabled={loadingSlots || slots.length === 0}
              defaultValue={state.values?.startsAt}
              className="h-9 rounded-control border border-line bg-bg px-3 font-mono text-body text-text"
              aria-invalid={Boolean(state.errors?.startsAt) || undefined}
              aria-describedby={
                state.errors?.startsAt ? "quick-add-time-error" : undefined
              }
            >
              {loadingSlots && <option value="">Loading times…</option>}
              {!loadingSlots && slots.length === 0 && (
                <option value="">No open times in the next two weeks</option>
              )}
              {slots.map((slot) => (
                <option key={slot.value} value={slot.value}>
                  {slot.label}
                </option>
              ))}
            </select>
            <FieldError
              id="quick-add-time-error"
              message={state.errors?.startsAt}
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-4">
          {/*
            Inline and persistent, not a toast. The row this refers to has just
            landed somewhere in a twenty-row table, and §11.4 reserves toasts for
            transient results.
          */}
          <p className="text-table text-text-muted" role="status">
            {state.added
              ? `Added ${state.added.name}, ${state.added.startsAt}.`
              : ""}
          </p>
          <SubmitButton />
        </div>
      </form>
    </section>
  )
}

/**
 * Its own component so `useFormStatus` reports on the form above it. A hook
 * called in `QuickCallCard` itself would see no form and never report pending —
 * it reports on the nearest `<form>` *above* the component that calls it. Same
 * arrangement as `components/settings/pending-submit-button.tsx`.
 */
function SubmitButton() {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" disabled={pending}>
      {/* On the button itself; §11.4 rules out a full-page blocker. */}
      {pending && <Loader2 className="animate-spin" aria-hidden />}
      {pending ? "Adding…" : "Add appointment"}
    </Button>
  )
}
```

- [ ] **Step 2: Verify it type-checks and lints**

Run: `npm run typecheck`
Expected: no output, exit 0.

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add components/overview/quick-call-card.tsx
git commit -m "Add the Quick Call card, offering only Slots Availability has open"
```

---

## Task 13: The Appointments table

**Files:**
- Create: `components/overview/appointments-table.tsx`
- Delete: `components/overview/appointments-list.tsx`

- [ ] **Step 1: Write the component**

Create `components/overview/appointments-table.tsx`:

```tsx
import { StatusPill } from "@/components/overview/status-pill"
import type { AppointmentRow } from "@/lib/business/list-appointments"
import { formatInZone } from "@/lib/time/zone"

/**
 * The Appointments a Business has (SPEC.md §11.3): Name · Phone · Service ·
 * Time · Status · Attempts · Last call.
 *
 * A **server** component on purpose, as the stub it replaces was: every time
 * here is formatted in the Business's own timezone, and doing that on the server
 * means one `Intl` pass and no chance of a hydration mismatch between the
 * viewer's clock and the Business's.
 *
 * The last Call renders as plain text, not a link. `/calls/[id]` is #16's
 * screen and does not exist yet, and a link to a 404 is worse than no link. The
 * column is here now so the shape does not change when it lands.
 *
 * Not here, deliberately: Upload CSV (#8), Call all (#17), the Needs Attention
 * section (#15), the row-level Call now action and the in-flight shimmer (#11).
 */

type AppointmentsTableProps = {
  appointments: AppointmentRow[]
  /** The Business's IANA zone — times mean nothing without it. */
  timezone: string
}

export function AppointmentsTable({
  appointments,
  timezone,
}: AppointmentsTableProps) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-page font-semibold tracking-tight text-text">
          Appointments
        </h2>
        <p className="text-body text-text-muted">Times shown in {timezone}.</p>
      </div>

      <div className="overflow-hidden rounded-card border border-line bg-surface">
        {/* Table above `md`, stacked cards below it (§11.4's 375px floor). */}
        <table className="hidden w-full text-table md:table">
          <thead>
            <tr className="border-b border-line text-left text-text-muted">
              <Th>Name</Th>
              <Th>Phone</Th>
              <Th>Service</Th>
              <Th>Time</Th>
              <Th>Status</Th>
              <Th>Attempts</Th>
              <Th>Last call</Th>
            </tr>
          </thead>
          <tbody>
            {appointments.map((appointment) => (
              <tr
                key={appointment.id}
                className="border-b border-line last:border-b-0"
              >
                <Td className="text-text">{appointment.name}</Td>
                <Td className="font-mono">{appointment.phoneE164}</Td>
                <Td>{appointment.serviceName}</Td>
                <Td className="font-mono">
                  {formatInZone(appointment.startsAt, timezone)}
                </Td>
                <Td>
                  <StatusPill status={appointment.status} />
                </Td>
                <Td className="font-mono">
                  <Attempts count={appointment.attempts} />
                </Td>
                <Td className="font-mono">
                  <LastCall
                    lastCallId={appointment.lastCallId}
                    attempts={appointment.attempts}
                  />
                </Td>
              </tr>
            ))}
            {appointments.length === 0 && (
              <tr>
                <Td className="text-text-muted" colSpan={7}>
                  No appointments yet.
                </Td>
              </tr>
            )}
          </tbody>
        </table>

        <ul className="md:hidden">
          {appointments.map((appointment) => (
            <li
              key={appointment.id}
              className="flex flex-col gap-2 border-b border-line p-4 last:border-b-0"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-body font-medium text-text">
                  {appointment.name}
                </span>
                <StatusPill status={appointment.status} />
              </div>
              <span className="font-mono text-table text-text-muted">
                {appointment.phoneE164}
              </span>
              <div className="flex items-baseline justify-between gap-3 text-table text-text-muted">
                <span>{appointment.serviceName}</span>
                <span className="font-mono">
                  {formatInZone(appointment.startsAt, timezone)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3 text-table text-text-muted">
                <span>
                  Attempts <Attempts count={appointment.attempts} />
                </span>
              </div>
            </li>
          ))}
          {appointments.length === 0 && (
            <li className="p-4 text-table text-text-muted">
              No appointments yet.
            </li>
          )}
        </ul>
      </div>
    </section>
  )
}

/*
  There structurally cannot be an empty list — onboarding seeds Appointments in
  the same transaction as the Business — so the empty rows above are not a
  designed empty state. They exist so that if the seed ever does fail, the
  screen says so instead of rendering an unexplained blank panel.
*/

/** "—" rather than "0", which reads as an attempt that failed. */
function Attempts({ count }: { count: number }) {
  return <span>{count === 0 ? "—" : count}</span>
}

/**
 * Plain text until #16 builds `/calls/[id]` to link to.
 *
 * The id is not rendered — it means nothing to anyone reading the screen. What
 * is shown is that a Call exists, which is the fact the column carries until
 * there is somewhere to go.
 */
function LastCall({
  lastCallId,
  attempts,
}: {
  lastCallId: string | null
  attempts: number
}) {
  if (!lastCallId) return <span>—</span>
  return <span>Attempt {attempts}</span>
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-2 font-medium">{children}</th>
}

function Td({
  children,
  className,
  colSpan,
}: {
  children: React.ReactNode
  className?: string
  colSpan?: number
}) {
  return (
    <td colSpan={colSpan} className={`px-4 py-3 text-text-muted ${className ?? ""}`}>
      {children}
    </td>
  )
}
```

- [ ] **Step 2: Delete the stub it replaces**

```bash
git rm components/overview/appointments-list.tsx
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: FAIL — `app/(app)/page.tsx` still imports the deleted file. Task 14 fixes it. Do not commit yet.

- [ ] **Step 4: Hold the commit**

The tree does not type-check between deleting the stub and rewiring the page, so this task's files are committed together with Task 14's. Nothing to run here.

---

## Task 14: Wire up the Overview page

**Files:**
- Modify: `app/(app)/page.tsx` (whole file)
- Modify: `docs/superpowers/specs/2026-08-17-appointments-quick-add-design.md`

- [ ] **Step 1: Rewrite the page**

Replace the whole of `app/(app)/page.tsx`:

```tsx
import { slotOptionsAction } from "@/app/(app)/actions"
import { AppointmentsTable } from "@/components/overview/appointments-table"
import { QuickCallCard } from "@/components/overview/quick-call-card"
import { StatStrip } from "@/components/overview/stat-strip"
import { appointmentStats } from "@/lib/business/appointment-stats"
import { listAppointments } from "@/lib/business/list-appointments"
import { listServices } from "@/lib/business/list-services"
import { requireBusiness } from "@/lib/business/require-business"

/**
 * Overview — the demo stage (SPEC.md §11.3), and the screen onboarding lands
 * on with its Template's seeded Appointments already in it.
 *
 * `requireBusiness()` is React-`cache()`d and the shell layout above has
 * already called it, so it costs no second query.
 *
 * Three of §11.3's items are deliberately absent, each with an owner: the Needs
 * Attention section is #15, Upload CSV is #8, and Call all — with the ~5s
 * revalidation while a Call is live — is #17 and #11.
 */
export default async function OverviewPage() {
  const { business } = await requireBusiness()

  const [appointments, stats, services] = await Promise.all([
    listAppointments(business.id),
    appointmentStats(business.id),
    listServices(business.id),
  ])

  /*
    Only the first Service's Slots are loaded here. Slot size is the Service
    duration, so one Service's times cannot be reused for another, and
    pre-computing every Service would make this page cost grow with the Service
    count. Changing the Service in the card calls `slotOptionsAction` for the
    rest.
  */
  const firstService = services[0]
  const initialSlots = firstService
    ? await slotOptionsAction(firstService.id)
    : []

  return (
    <div className="flex flex-col gap-8">
      <StatStrip stats={stats} />

      <QuickCallCard
        services={services}
        initialSlots={initialSlots}
        timezone={business.timezone}
      />

      <AppointmentsTable
        appointments={appointments}
        timezone={business.timezone}
      />
    </div>
  )
}
```

- [ ] **Step 2: Update the design doc's naming**

In `docs/superpowers/specs/2026-08-17-appointments-quick-add-design.md`, replace every `outside_hours` with `not_offered`, and replace the row in the refusal table:

```markdown
| `not_offered` | "That is not a time you can book. Pick one from the list." | the time field |
```

Then add this under "Known limitations, stated deliberately":

```markdown
- **`not_offered` covers two different problems.** A time when the Business is
  closed, and a time inside opening hours but off the Slot grid — 09:07 when
  Slots run 09:00, 10:00, 11:00. Both read the same to the person, and the
  picker only offers grid-aligned times, so the second is only reachable by a
  forged POST.
```

- [ ] **Step 3: Run everything**

Run: `npm run typecheck`
Expected: no output, exit 0.

Run: `npm run lint`
Expected: no errors.

Run: `npm test`
Expected: PASS, the whole suite. `lib/onboarding/seed-schedule.test.ts` must be green and untouched — it is the contract for the last acceptance criterion.

- [ ] **Step 4: Commit**

```bash
git add app/\(app\)/page.tsx components/overview/ docs/superpowers/specs/2026-08-17-appointments-quick-add-design.md
git commit -m "Build Overview's real surface — stat strip, quick-add card, table"
```

---

## Task 15: Check it in the browser

Automated tests cannot reach `requireBusiness()`, which needs a Clerk session. These six checks cover what the tests cannot, and each maps to one of #7's acceptance criteria.

**Files:** none

- [ ] **Step 1: Start the app**

Run: `npm run dev`
Open `http://localhost:3000` and sign in. Onboard a new account if you do not have one.

- [ ] **Step 2: Walk the acceptance criteria**

| # | Check | Criterion |
|---|---|---|
| 1 | The stat strip reads Total 5, Confirmed 1, Needs attention 0, Answer rate — | seeded data, stat strip |
| 2 | Add an Appointment from the card. It appears in the table with no manual refresh | quick-add |
| 3 | Change the Service. The time list reloads and the durations differ | Slot picker |
| 4 | Type `9820012345` with no `+`. The message under the field asks for a country code | E.164 |
| 5 | In a second tab, book the same Slot. The first tab's submit says "Someone just booked that time" | refusal with a reason |
| 6 | Status pills show a coloured dot plus a word, matching §11.2 | status colours |

- [ ] **Step 3: Check it at 375px**

Open dev tools, set the viewport to 375px wide. The table becomes stacked cards and nothing scrolls sideways (§11.4).

- [ ] **Step 4: Check the keyboard**

Tab through the card. Every field and the button take a visible teal focus ring at 2px offset (§11.4).

- [ ] **Step 5: Commit anything the walk-through fixed**

If nothing needed fixing, there is nothing to commit.

```bash
git status
```

---

## Notes for whoever executes this

**Run `npx next typegen` once before the first `npm run typecheck`.** Next 16
generates the `LayoutProps` and `PageProps` types into `.next/types` at build
time, so on a tree that has never been built `tsc` reports five
`Cannot find name 'LayoutProps'` errors that have nothing to do with your work.
After `next typegen`, `npm run typecheck` exits 0 with no output — which is what
every task below expects.

**Run the tests one file at a time while working.** `fileParallelism` is off and the whole suite shares one Postgres, so `npm test` runs everything serially and takes a while. `npm test -- lib/appointments/create.test.ts` is the fast loop.

**Every test file cleans up after itself, children first.** Every FK in this schema is `ON DELETE NO ACTION`, so deleting a Business before its Appointments fails and poisons the next run. Copy the `cleanup()` shape from the task rather than inventing one.

**Do not add a "is this Slot free" check anywhere.** If a test seems to want one, read `lib/availability/offered.ts`'s header first. The concurrency test in Task 4 exists to catch exactly that edit.

**Do not touch `lib/onboarding/seed-schedule.ts` or its test.** The seed is done, and a second seed collides with `appointments_no_overlap`.
