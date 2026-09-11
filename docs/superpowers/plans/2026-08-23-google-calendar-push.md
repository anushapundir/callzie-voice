# Google Calendar push and Collision detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A booking made in Callzie appears on the Business's connected Google Calendar, and an overlapping event the owner created by hand raises a Collision that blocks calling until a human clears it. One-way only: Google never changes Callzie's state.

**Architecture:** One reconciler, `syncAppointmentToGoogle(id)`, reads the Appointment row and decides insert, patch, delete or nothing — callers never pick a verb, which is what makes it safe to run twice. Every Google call runs inside `after()` so nothing is added to the latency of a live Call. Detection is a second read, because Google permits overlaps and reports none on insert. A new `collision_event_ids` column remembers what has already been reported, so clearing a Collision sticks.

**Tech Stack:** Next.js 16 App Router, TypeScript, Drizzle + Postgres, Tailwind + shadcn/ui, Vitest against a real local Postgres.

**Design:** `docs/superpowers/specs/2026-08-23-google-calendar-push-design.md`
**Issue:** [#20](https://github.com/anushapundir/callzie/issues/20)
**ADRs:** [0004](../../adr/0004-google-calendar-is-one-way.md) (one-way, behind a flag), [0009](../../adr/0009-application-encrypts-google-refresh-tokens.md) (token encryption), [0007](../../adr/0007-wall-clock-to-instant-without-a-timezone-library.md) (timezone arithmetic)

---

## Before you start

Read these four. They are the patterns every task below copies.

1. `lib/google/oauth.ts` — the injected-`fetch` shape, and how a Google failure is reported without leaking the body into a log. Tasks 3 and 4 follow it exactly.
2. `lib/google/connection.ts` — `googleConnection()`, `storeGoogleConnection()`, `clearGoogleConnection()`. Task 3 calls the last of these; do not write a second way to clear a connection.
3. `app/api/webhooks/retell/route.ts:60-90` — the `after()` block. Tasks 9 to 12 copy it, including the comment explaining why the work is deferred.
4. `lib/calls/record.ts:126-148` — `flagTruncated`, the conditional-UPDATE shape. Tasks 5 and 6 both put their guard inside the `WHERE` rather than in an `if` before it.

**Five facts about this repo that will save you time:**

- Tests run against a **real Postgres started for you** by `vitest.globalSetup.ts`. There is no database mocking layer. `npm test` just works with no network and no secrets.
- **No test may call Google.** SPEC.md §3 rule 11 forbids real Calls; the same reasoning applies to an API that rate-limits and needs a real human consent. Every test injects a fake `fetch`.
- **Everything here is dead code without three env vars.** `googleCalendarConfigured()` needs `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `TOKEN_ENCRYPTION_KEY`. A deployment without them is correctly configured, not degraded (ADR-0004).
- **The connection expires every seven days.** Google issues a 7-day refresh token to any Testing-status app using a sensitive scope. This is expected, is handled as a designed state in Task 3, and is not a bug to chase.
- `npm run typecheck` needs Next's generated route types. On a fresh worktree run `npx next typegen` once first.

**Commands:**

| What | Command |
|---|---|
| One test file | `npm test -- lib/google/overlap.test.ts` |
| One test by name | `npm test -- lib/google/overlap.test.ts -t "all-day"` |
| Everything | `npm test` |
| Types | `npm run typecheck` |
| Lint | `npm run lint` |
| Migration | `npm run db:generate` then `npm run db:migrate` |
| Real Google smoke test | `npm run try-google` |

---

## File structure

### Created

| File | Responsibility |
|---|---|
| `lib/google/overlap.ts` | Pure. Which Appointments overlap which Google events. All-day expansion and the whole-day window |
| `lib/google/overlap.test.ts` | Every rule, no database, no fetch |
| `lib/google/token.ts` | `accessTokenFor` — decrypt, refresh, and turn `invalid_grant` into a lost connection |
| `lib/google/token.test.ts` | A good refresh, a lost grant, a transient 500 |
| `lib/google/events.ts` | The four HTTP calls and nothing else |
| `lib/google/events.test.ts` | Request shapes, and the 404/410 delete cases |
| `lib/google/collision.ts` | `raiseCollisions` — the set subtraction and the guarded write |
| `lib/google/collision.test.ts` | The seven-step walkthrough, against real Postgres |
| `lib/google/sync.ts` | `syncAppointmentToGoogle` — the reconciler, the compare-and-set, the push-time read |
| `lib/google/sync.test.ts` | All four reconciler rows, idempotence, the insert race |
| `lib/google/recheck.ts` | `recheckCollisions` — the bounded whole-day span read |
| `lib/google/recheck.test.ts` | Bounding, and one request for many Appointments |
| `components/overview/collision-check.tsx` | The one client island. Fires the re-check once on mount |
| `scripts/try-google.ts` | Real-API smoke test against the builder's own calendar |
| `drizzle/0005_fine_obadiah_stane.sql` | The two columns (generated by `db:generate`) |

### Modified

| File | Change |
|---|---|
| `lib/db/schema.ts` | `collisionEventIds` on `appointments`, `googleAccessLostAt` on `businesses` |
| `lib/db/schema.test.ts` | The new columns exist and carry their defaults |
| `lib/appointments/reschedule.ts` | Wipe `collision_event_ids` in the same UPDATE that moves the Appointment |
| `lib/appointments/reschedule.test.ts` | The wipe happens, and only on a successful move |
| `lib/tools/handle.ts` | `after()` for `book_slot` and `cancel_appointment` only |
| ~~`lib/tools/handle.test.ts`~~ | Does not exist. The assertions went into `app/api/tools/routes.test.ts`, which already drives the real handlers |
| `lib/extraction/outcome.ts` | Sync on the decline path |
| `lib/extraction/outcome.test.ts` | Unchanged — the existing suite already covers which outcomes write |
| `app/(app)/actions.ts` | `after()` on quick-add and CSV; `recheckCollisionsAction`; revalidate `/schedule` on clear |
| `app/(app)/page.tsx` | Mount `collision-check.tsx` |
| `components/settings/google-calendar-section.tsx` | The copy currently says events are not syncing. Plus the seven-day line and the lost-access line |
| ~~`components/settings/google-calendar-section.test.tsx`~~ | Does not exist. The lost-access state is covered in `lib/google/connection.test.ts`, where the logic lives |
| `lib/google/connection.ts` | `storeGoogleConnection` clears `google_access_lost_at`; `googleConnection` reports it |
| `docs/verification.md` | The verified facts, and §13 item 4 answered |
| `package.json` | `try-google` |

**Why `overlap.ts` is separate from `events.ts`.** The interesting rules — touching edges, all-day, transparent, our own event — are arithmetic and filtering with no network in them. Keeping them in a pure module means they are tested without a fake `fetch` standing between the test and the rule.

---

## Task 1: The two columns

Do this first. Tasks 3, 5 and 6 all write to columns that do not exist yet.

**Files:**
- Modify: `lib/db/schema.ts`, `lib/db/schema.test.ts`
- Create: `drizzle/0005_fine_obadiah_stane.sql` via `npm run db:generate`

- [x] **Step 1: Add the columns to the Drizzle schema**

On `appointments`:

```ts
// The Google event ids Callzie has already raised a Collision about for this
// Appointment. NOT cleared by clearNeedsAttention, and that is the point: a
// human who clears a Collision has seen it, so the same overlapping event must
// not raise it again five seconds later. A Reschedule DOES wipe it — a new time
// is a new question (lib/appointments/reschedule.ts).
collisionEventIds: text("collision_event_ids")
  .array()
  .notNull()
  .default(sql`'{}'`),
```

On `businesses`:

```ts
// When Callzie last found the Google grant gone. Set from a refresh that came
// back `invalid_grant`, which covers both an owner revoking access and the
// seven-day expiry every Testing-status app gets. Cleared on reconnect.
//
// A column rather than a GoogleStatus value because those ride on a query
// parameter from the OAuth callback redirect, and this is discovered by a
// background push with nobody watching.
googleAccessLostAt: timestamp("google_access_lost_at", { withTimezone: true }),
```

- [x] **Step 2: Generate and apply the migration**

`npm run db:generate`, then read the generated SQL before running it. It should be two `ALTER TABLE ... ADD COLUMN` statements and nothing else. If it wants to drop or recreate anything, stop — the snapshot is stale.

`npm run db:migrate` needs `.env.local` and the Cloud SQL Auth Proxy (see CLAUDE.md).

- [x] **Step 3: Extend the schema test**

`lib/db/schema.test.ts` already parses migrations to prove the constraint lists have not drifted. Add: a fresh Appointment has `collisionEventIds` equal to `[]`, not null; a fresh Business has `googleAccessLostAt` null.

- [x] **Step 4: Verify**

`npm test -- lib/db/schema.test.ts` — PASS. Then `npm test` to prove no existing insert broke on a new NOT NULL column.

---

## Task 2: The overlap rules, pure

The heart of the feature, and the only part with real arithmetic. No database, no network.

**Files:**
- Create: `lib/google/overlap.ts`, `lib/google/overlap.test.ts`

- [x] **Step 1: Write the failing test**

Create `lib/google/overlap.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  overlappingEventIds,
  wholeDayWindow,
  type CalendarEvent,
} from "@/lib/google/overlap";

/*
  ADR-0004: Google permits overlapping events and reports no conflict on insert,
  so detection is a deliberate second read. These are the rules that read
  applies. All of it is pure, because "does 09:45 touch 09:45" should not need a
  database or a fake fetch to answer.

  Times are written as explicit UTC instants. The Business here is in
  Asia/Kolkata (UTC+5:30), so 14:00 local is 08:30Z — spelled out rather than
  computed, so a broken zone helper cannot make a wrong test pass.
*/

const ZONE = "Asia/Kolkata";

/** 14:00 → 14:45 on 2026-08-25, Kolkata. */
const APPOINTMENT = {
  id: "appt-1",
  startsAt: new Date("2026-08-25T08:30:00Z"),
  endsAt: new Date("2026-08-25T09:15:00Z"),
  googleEventId: "evt-ours",
};

function timed(id: string, from: string, to: string): CalendarEvent {
  return { id, start: { dateTime: from }, end: { dateTime: to } };
}

describe("overlappingEventIds", () => {
  it("finds an event sitting across the Appointment", () => {
    // The demo case: the owner adds "Dentist" 14:30 → 15:00 by hand.
    const events = [timed("evt-dentist", "2026-08-25T09:00:00Z", "2026-08-25T09:30:00Z")];

    expect(overlappingEventIds({ events, windows: [APPOINTMENT], timeZone: ZONE }))
      .toEqual(new Map([["appt-1", ["evt-dentist"]]]));
  });

  it("does not treat touching at the edge as a collision", () => {
    /*
      13:15 → 14:00 ends exactly when the Appointment starts. Back-to-back
      bookings are the normal case, not a conflict — SPEC.md's Slots are
      half-open ranges and so is the appointments_no_overlap constraint.
    */
    const before = timed("evt-before", "2026-08-25T07:45:00Z", "2026-08-25T08:30:00Z");
    const after = timed("evt-after", "2026-08-25T09:15:00Z", "2026-08-25T10:00:00Z");

    expect(
      overlappingEventIds({ events: [before, after], windows: [APPOINTMENT], timeZone: ZONE }),
    ).toEqual(new Map());
  });

  it("ignores the event Callzie itself wrote", () => {
    /*
      Callzie cannot collide with itself: appointments_no_overlap makes two
      overlapping Callzie Appointments impossible in Postgres. Without this the
      push-time read would flag every single booking against its own event.
    */
    const ours = timed("evt-ours", "2026-08-25T08:30:00Z", "2026-08-25T09:15:00Z");

    expect(overlappingEventIds({ events: [ours], windows: [APPOINTMENT], timeZone: ZONE }))
      .toEqual(new Map());
  });

  it("ignores an event marked Free", () => {
    // `transparent` is Google's "Show me as Available". A birthday reminder is
    // not a double-booking.
    const free: CalendarEvent = {
      ...timed("evt-free", "2026-08-25T09:00:00Z", "2026-08-25T09:30:00Z"),
      transparency: "transparent",
    };

    expect(overlappingEventIds({ events: [free], windows: [APPOINTMENT], timeZone: ZONE }))
      .toEqual(new Map());
  });

  it("treats an event with no transparency field as busy", () => {
    /*
      The field is ABSENT on most events, because `opaque` is Google's default.
      Testing for `!== "opaque"` would ignore almost every real event on the
      calendar, which is the quiet way this feature could ship doing nothing.
    */
    const events = [timed("evt-plain", "2026-08-25T09:00:00Z", "2026-08-25T09:30:00Z")];

    expect(overlappingEventIds({ events, windows: [APPOINTMENT], timeZone: ZONE }))
      .toEqual(new Map([["appt-1", ["evt-plain"]]]));
  });

  it("ignores a cancelled event", () => {
    // showDeleted defaults to false so these should not arrive, but `get` and
    // sync responses do return them and one filter is cheaper than one bug.
    const gone: CalendarEvent = {
      ...timed("evt-gone", "2026-08-25T09:00:00Z", "2026-08-25T09:30:00Z"),
      status: "cancelled",
    };

    expect(overlappingEventIds({ events: [gone], windows: [APPOINTMENT], timeZone: ZONE }))
      .toEqual(new Map());
  });

  it("treats an all-day event as covering the whole day", () => {
    /*
      Google represents an all-day event as start.date / end.date, with end
      EXCLUSIVE — so a single day off on the 25th is 25th → 26th. Expanded to
      midnight-to-midnight in the BUSINESS's zone: 2026-08-24T18:30Z to
      2026-08-25T18:30Z for Kolkata.

      This is a deliberate product decision, not an accident of the arithmetic:
      if the owner blocked the whole day out, every Appointment in it really is
      a problem.
    */
    const vacation: CalendarEvent = {
      id: "evt-vacation",
      start: { date: "2026-08-25" },
      end: { date: "2026-08-26" },
    };

    expect(overlappingEventIds({ events: [vacation], windows: [APPOINTMENT], timeZone: ZONE }))
      .toEqual(new Map([["appt-1", ["evt-vacation"]]]));
  });

  it("does not let an all-day event bleed into the next day", () => {
    // end.date is exclusive. A one-day event must not catch an Appointment on
    // the 26th, which an off-by-one here would.
    const vacation: CalendarEvent = {
      id: "evt-vacation",
      start: { date: "2026-08-24" },
      end: { date: "2026-08-25" },
    };

    expect(overlappingEventIds({ events: [vacation], windows: [APPOINTMENT], timeZone: ZONE }))
      .toEqual(new Map());
  });

  it("matches many Appointments against one list of events", () => {
    // The whole reason this takes a list: one events.list request answers for
    // every upcoming Appointment at once.
    const second = {
      id: "appt-2",
      startsAt: new Date("2026-08-25T10:30:00Z"),
      endsAt: new Date("2026-08-25T11:15:00Z"),
      googleEventId: null,
    };
    const wide = timed("evt-wide", "2026-08-25T08:00:00Z", "2026-08-25T12:00:00Z");

    expect(
      overlappingEventIds({ events: [wide], windows: [APPOINTMENT, second], timeZone: ZONE }),
    ).toEqual(
      new Map([
        ["appt-1", ["evt-wide"]],
        ["appt-2", ["evt-wide"]],
      ]),
    );
  });

  it("returns nothing for an empty calendar", () => {
    expect(overlappingEventIds({ events: [], windows: [APPOINTMENT], timeZone: ZONE }))
      .toEqual(new Map());
  });
});

describe("wholeDayWindow", () => {
  it("widens a single Appointment to its whole local day", () => {
    /*
      Why widen at all: Google does not document how a date-only event is
      compared against timeMin/timeMax, and all-day events are load-bearing
      here. Asking for the whole day means an all-day event is unambiguously in
      range however Google resolves it.

      Kolkata midnight on the 25th is 2026-08-24T18:30Z; the next midnight is
      2026-08-25T18:30Z.
    */
    expect(wholeDayWindow([APPOINTMENT], ZONE)).toEqual({
      timeMin: new Date("2026-08-24T18:30:00Z"),
      timeMax: new Date("2026-08-25T18:30:00Z"),
    });
  });

  it("spans from the first day to the last", () => {
    const later = {
      id: "appt-2",
      startsAt: new Date("2026-08-27T08:30:00Z"),
      endsAt: new Date("2026-08-27T09:15:00Z"),
      googleEventId: null,
    };

    expect(wholeDayWindow([APPOINTMENT, later], ZONE)).toEqual({
      timeMin: new Date("2026-08-24T18:30:00Z"),
      timeMax: new Date("2026-08-27T18:30:00Z"),
    });
  });

  it("returns null for no Appointments, so no request is made", () => {
    // The caller must be able to skip the HTTP call entirely rather than ask
    // Google about an empty range.
    expect(wholeDayWindow([], ZONE)).toBeNull();
  });
});
```

- [x] **Step 2: Run it and watch it fail**

`npm test -- lib/google/overlap.test.ts` → FAIL, `Failed to resolve import "@/lib/google/overlap"`.

- [x] **Step 3: Write the implementation**

Create `lib/google/overlap.ts`. It exports:

- `type CalendarEvent` — `id`, optional `status`, optional `transparency`, and `start`/`end` each carrying an optional `dateTime` and an optional `date`. Model both as optional; Google sends one or the other and a type that pretends otherwise will lie at the first all-day event.
- `type AppointmentWindow` — `id`, `startsAt`, `endsAt`, `googleEventId`.
- `wholeDayWindow(windows, timeZone)` — `null` for an empty list, otherwise midnight before the earliest and midnight after the latest, using `todayInZone`/`addCalendarDays`/`zonedTimeToInstant` from `lib/time/zone.ts`. Do not add 24 hours in milliseconds: a day is not always 24 hours, and ADR-0007 exists because of exactly that.
- `overlappingEventIds({ events, windows, timeZone })` — a `Map<appointmentId, eventId[]>` containing only Appointments with at least one overlap.

The overlap test is `startsAt < otherEnd && endsAt > otherStart`. Strictly less and strictly greater — touching is not overlapping.

Resolve each event to a pair of instants first, then compare. An all-day event resolves to midnight-at-`start.date` and midnight-at-`end.date` in the Business's zone, both via `zonedTimeToInstant`. Skip any event that resolves to neither shape rather than guessing.

Filter order: drop `status === "cancelled"`, drop `transparency === "transparent"`, drop any id matching the window's own `googleEventId`. Nothing else.

- [x] **Step 4: Verify**

`npm test -- lib/google/overlap.test.ts` — all PASS. Then `npm run typecheck` and `npm run lint`.

---

## Task 3: The access token, and losing it

**Files:**
- Create: `lib/google/token.ts`, `lib/google/token.test.ts`
- Modify: `lib/google/connection.ts`

- [x] **Step 1: Write the failing test**

`lib/google/token.test.ts`, against real Postgres with an injected `fetch`:

- A stored, encrypted refresh token produces an access token. Assert the request went to `https://oauth2.googleapis.com/token`, was `application/x-www-form-urlencoded`, and carried `grant_type=refresh_token` plus `refresh_token`, `client_id`, `client_secret`.
- A 400 with `{"error":"invalid_grant"}` returns `null`, nulls both Google columns on the Business, and stamps `google_access_lost_at`. This is the seven-day expiry as much as it is a revocation — the same handling covers both.
- A 500 returns `null` and changes **nothing**. Assert the refresh token is still in the row. A transient Google failure must never destroy a working credential.
- A response with no `refresh_token` field leaves the stored one alone. Google only returns one when `access_type=offline` was set on the original request, so its absence is normal, not a signal.
- A Business with no refresh token returns `null` and makes **no HTTP call at all**. Assert the fake `fetch` was never invoked.
- A deployment with `googleCalendarConfigured()` false returns `null` and makes no call.

- [x] **Step 2: Run it and watch it fail**

- [x] **Step 3: Write the implementation**

`accessTokenFor(businessId, fetchImpl = fetch): Promise<AccessGrant | null>` where `AccessGrant` is `{ accessToken, calendarId }` — the two things every caller needs together, so nobody has to remember to read the calendar id separately.

It reads the Business row, returns `null` early if the flag is off or there is no token, decrypts through `decryptSecret` (ADR-0009 — never read that column directly), and posts the refresh.

On `invalid_grant`, call the existing `clearGoogleConnection(businessId)` and set `google_access_lost_at`. Do not write a second clearing path.

Match on `body.error === "invalid_grant"` and nothing looser. Google documents an `error_subtype` that distinguishes a revoked token from a session-policy failure; both mean reconnect, so the subtype is not read, but note in a comment that it exists.

Never put the response body in a log message — `oauth.ts` explains why at length and the same applies here.

Then in `lib/google/connection.ts`: `storeGoogleConnection` also sets `googleAccessLostAt: null`, and `GoogleConnection` gains an `accessLostAt` field so Settings can render the explanation.

- [x] **Step 4: Verify**

`npm test -- lib/google/token.test.ts lib/google/connection.test.ts` — PASS.

---

## Task 4: The four HTTP calls

**Files:**
- Create: `lib/google/events.ts`, `lib/google/events.test.ts`

- [x] **Step 1: Write the failing test**

Assert request shapes, since these are the payloads SPEC.md §3 rule 12 says to verify:

- `insertEvent` — `POST` to `/calendar/v3/calendars/{calendarId}/events`, `Authorization: Bearer`, body carrying `summary`, `start.dateTime`, `start.timeZone`, `end.dateTime`, `end.timeZone`. Returns the `id` from the response. Assert the `calendarId` is URL-encoded: it is usually an email address, and an unencoded `@` in a path is a bug waiting for the one account whose address needs it.
- `patchEvent` — `PATCH` to `.../events/{eventId}`, body carrying **only** `start` and `end`. Patch semantics means unspecified fields are left alone, so sending `summary` again would be noise at best and would clobber an owner's edit at worst.
- `deleteEvent` — `DELETE`. A 204 succeeds. **A 404 succeeds** and **a 410 succeeds**: the goal is that the event is not on the calendar, and it is not. Google's own guidance for the 410 case is "no further action is necessary". A 500 throws.
- `listEvents` — `GET` with `timeMin`, `timeMax`, `singleEvents=true`. Assert `singleEvents` is actually present: it defaults to false, and without it a recurring meeting comes back as the rule rather than this week's instance, so the occupied slot is silently missed. Assert the timestamps are RFC3339 with an offset, which Google requires.

- [x] **Step 2: Run it and watch it fail**

- [x] **Step 3: Write the implementation**

Four functions, `fetchImpl` injected on each, matching `oauth.ts`. No business logic — no deciding which verb to use, no filtering of results. That belongs in Tasks 2 and 6.

Do not paginate `listEvents`. The default page size is 250 and the window is at most 14 days of one small business's calendar. If `nextPageToken` ever comes back, log it and use what arrived — a partial answer that raises some Collisions beats an exception that raises none.

- [x] **Step 4: Verify**

---

## Task 5: Raising a Collision, and making Clear stick

**Files:**
- Create: `lib/google/collision.ts`, `lib/google/collision.test.ts`

- [x] **Step 1: Write the failing test**

Real Postgres. This is the seven-step walkthrough from the design, as assertions:

1. No overlap → no reason, empty id list.
2. An overlap with `evt-dentist` → `needs_attention_reason` is `collision`, `collision_event_ids` is `["evt-dentist"]`.
3. Running again with the same overlap → **nothing changes**. Assert the id list did not grow to `["evt-dentist","evt-dentist"]`.
4. `clearNeedsAttention` → reason null, id list **still** `["evt-dentist"]`.
5. Running again with the same overlap → **still clear**. This is the assertion the whole column exists for.
6. A new overlapping `evt-lunch` → raised again, list is both ids.
7. An Appointment already carrying `book_failed` → reason stays `book_failed` **and the id list stays empty**. Both halves matter: recording the id without raising would mean clearing the `book_failed` silently swallows a Collision nobody was ever shown.

- [x] **Step 2: Run it and watch it fail**

- [x] **Step 3: Write the implementation**

`raiseCollisions(found: Map<string, string[]>): Promise<number>`, returning how many Appointments were newly flagged — the caller uses that to decide whether to revalidate.

Per Appointment: read `needs_attention_reason` and `collision_event_ids`, skip entirely if a reason is already set, subtract the seen ids, and skip if nothing is left. Then a guarded UPDATE:

```sql
UPDATE appointments
   SET needs_attention_reason = 'collision',
       collision_event_ids = $all
 WHERE id = $id
   AND needs_attention_reason IS NULL
   AND collision_event_ids = $seen
```

Both extra clauses are compare-and-set, in the `WHERE` rather than in an `if` above it — the shape `flagTruncated` uses. `collision_event_ids = $seen` means a concurrent sync that already appended cannot be overwritten by this one's stale copy.

- [x] **Step 4: Verify**

---

## Task 6: The reconciler

**Files:**
- Create: `lib/google/sync.ts`, `lib/google/sync.test.ts`

- [x] **Step 1: Write the failing test**

Real Postgres, faked Google:

- Slot-holding, no `google_event_id` → **insert**, and the returned id is stored.
- Slot-holding, `google_event_id` set → **patch**, no insert. Assert no second event was created.
- `cancelled` with an id → **delete**, and the column is nulled.
- `cancelled` with no id → **no HTTP call at all**.
- Run twice in a row → the second run patches and changes nothing else. Idempotence is the retry story; assert it rather than assuming it.
- A 410 on delete still nulls the column.
- **The insert race:** make the conditional UPDATE match zero rows (write an id into the row from the test between the insert and the write-back), and assert the loser calls `deleteEvent` on the event it just created. An orphan on somebody's real calendar is the failure this prevents.
- A Business with no Google connection → returns immediately, **zero** HTTP calls. ADR-0004's hard requirement, asserted rather than assumed.
- After an insert or patch, the push-time read runs and a pre-existing overlapping event raises a Collision.
- A Google error anywhere → logged, **no** Needs Attention row written. There is no "the push failed" reason and a Google outage must not invent one.

- [x] **Step 2: Run it and watch it fail**

- [x] **Step 3: Write the implementation**

`syncAppointmentToGoogle(appointmentId, fetchImpl = fetch): Promise<void>`.

Read the Appointment joined to its Business — it needs the status, the times, `google_event_id`, the timezone, and the connection. Call `accessTokenFor`; a `null` means return, having done nothing.

Decide the verb from `SLOT_HOLDING_STATUSES` in `lib/db/schema.ts`. Import the constant; do not re-list the statuses. If that list and this code ever disagree, the calendar starts holding events for Appointments the exclusion constraint has already released.

The event summary should name the customer and the Service — the owner is looking at their own calendar and "Appointment" tells them nothing.

Wrap the whole body so nothing escapes. This runs in `after()`, where an unhandled rejection is an unhandled rejection in a server process, not a failed request somebody sees.

- [x] **Step 4: Verify**

---

## Task 7: The bounded re-check

**Files:**
- Create: `lib/google/recheck.ts`, `lib/google/recheck.test.ts`

- [x] **Step 1: Write the failing test**

- Ten upcoming Appointments cost **exactly one** `events.list` call. Count the calls; this is the whole reason the helper takes a list.
- An Appointment 20 days out is not considered.
- A `cancelled` Appointment is not considered.
- A past Appointment is not considered.
- The window sent to Google is whole days in the Business's zone, not the first Appointment's start.
- No upcoming Appointments → **no HTTP call**.
- No connection → no HTTP call.

- [x] **Step 2: Run it and watch it fail**

- [x] **Step 3: Write the implementation**

`recheckCollisions(businessId, fetchImpl = fetch): Promise<number>` returning how many Collisions were newly raised.

Select Slot-holding, future Appointments starting within 14 days, ordered by start, **limit 100**. Both bounds are the answer to the note at `lib/business/needs-attention.ts:17`, which asks this ticket to bound its own detection rather than leave the panel to cap it. Put that reference in a comment so the connection survives.

Then `wholeDayWindow`, one `listEvents`, one `overlappingEventIds`, one `raiseCollisions`.

- [x] **Step 4: Verify**

---

## Task 8: A Reschedule wipes the reported ids

**Files:**
- Modify: `lib/appointments/reschedule.ts`, `lib/appointments/reschedule.test.ts`

- [x] **Step 1: Write the failing test**

A successful move clears `collision_event_ids`. A move that loses the race to the exclusion constraint leaves it alone.

- [x] **Step 2: Run it and watch it fail**

- [x] **Step 3: Write the implementation**

Add `collisionEventIds: []` to the `SET` clause of the existing UPDATE. In the same statement, not a second one — a window where the Appointment has moved but still remembers the old day's conflicts is a window where a real Collision gets swallowed.

Comment it: a new time is a new question, and events that conflicted with 10:00 say nothing about 16:00.

- [x] **Step 4: Verify**

---

## Task 9: Push from the Tool path

The latency-critical one. Get the `after()` placement right here and the rest follow.

**Files:**
- Modify: `lib/tools/handle.ts`, `lib/tools/handle.test.ts`

- [x] **Step 1: Write the failing test**

- `book_slot` schedules a sync. `cancel_appointment` schedules a sync.
- `check_availability` and `confirm_appointment` schedule **nothing** — neither changes a time or ends an Appointment, so a push would be a wasted round trip on every offer Maya makes.
- The response body is unchanged and returns without waiting for Google.

- [x] **Step 2: Run it and watch it fail**

- [x] **Step 3: Write the implementation**

In `handleToolRequest`, after `runTool` returns and before the `NextResponse.json`:

```ts
/*
  after() runs this once the response is already on its way to Retell. Maya is
  mid-conversation and a Google round trip here would be dead air — the same
  reason app/api/webhooks/retell/route.ts defers its work.

  Only the two Tools that change what is on the calendar. check_availability
  offers times and confirm_appointment changes a status; neither moves an
  Appointment, so neither has anything to push.
*/
if (CALENDAR_CHANGING_TOOLS.includes(name)) {
  after(() => syncAppointmentToGoogle(context.appointment.id));
}
```

Declare `CALENDAR_CHANGING_TOOLS` as a `const` array of `ToolName` in this file, so adding a fifth Tool forces a decision rather than silently getting no push.

Note the ordering that matters: `runTool` has committed its transaction by the time it returns. ADR-0004 requires Postgres first, then the push, and this is where that is guaranteed.

- [x] **Step 4: Verify**

---

## Task 10: Push from quick-add and CSV upload

**Files:**
- Modify: `app/(app)/actions.ts`

- [x] **Step 1: Write the failing test**

A successful quick-add schedules one sync. A rejected one schedules none. A CSV upload of three good rows and one bad row schedules three.

- [x] **Step 2: Run it and watch it fail**

- [x] **Step 3: Write the implementation**

`after()` in both actions, using the ids `createAppointment` returned. For the CSV path, one `after()` that loops the ids sequentially rather than one per row — a fifty-row upload should not open fifty concurrent connections to Google.

- [x] **Step 4: Verify**

---

## Task 11: Push on a decline

**Files:**
- Modify: `lib/extraction/outcome.ts`, `lib/extraction/outcome.test.ts`

- [x] **Step 1: Write the failing test**

A decline syncs, which deletes the event. A `confirmed` does not — the time did not change. A write blocked by the `status = 'pending'` guard syncs nothing.

- [x] **Step 2: Run it and watch it fail**

- [x] **Step 3: Write the implementation**

Call `syncAppointmentToGoogle` directly, **not** in `after()`. This code already runs inside the Retell webhook's `after()` block; nesting another one would be a second deferral of work that is already deferred.

Only when the UPDATE actually matched a row. The guard is in the `WHERE`, so use the returned row count rather than assuming the write landed.

- [x] **Step 4: Verify**

---

## Task 12: The on-screen re-check

**Files:**
- Create: `components/overview/collision-check.tsx`
- Modify: `app/(app)/actions.ts`, `app/(app)/page.tsx`

- [x] **Step 1: Write the failing test**

- The action calls `recheckCollisions` for the signed-in Business only.
- It revalidates `/` **and** `/schedule` when something was raised.
- It revalidates **nothing** when nothing was raised. This is the loop guard: a client component firing on mount plus an unconditional revalidate re-renders forever. It is safe only because a cleared Collision is never re-raised, so the second run writes nothing.

- [x] **Step 2: Run it and watch it fail**

- [x] **Step 3: Write the implementation**

`recheckCollisionsAction` in `app/(app)/actions.ts`, scoped through `requireBusiness()` like every other action there.

`collision-check.tsx` is a client component rendering nothing — a `useEffect` with an empty dependency array that calls the action once and ignores the result. Mount it inside the Overview tree.

While you are in `app/(app)/actions.ts`, fix the note left at `lib/appointments/clear-attention.ts:26`: `clearAttentionAction` revalidates only `/`, and Schedule reads the same column to draw its Collision marker. Add `revalidatePath("/schedule")`. That file predicted this exact bug for the day something started writing `collision`.

- [x] **Step 4: Verify**

`npm run dev`, book something, add an overlapping event in Google by hand, reload Overview, watch the row appear. Then Clear it and reload twice — it must stay gone.

---

## Task 13: Tell the owner the truth on Settings

**Files:**
- Modify: `components/settings/google-calendar-section.tsx`, and its test

- [x] **Step 1: Write the failing test**

Four states: not configured, not connected, connected, and connected-then-lost. Assert the connected state no longer claims events are not syncing.

- [x] **Step 2: Run it and watch it fail**

- [x] **Step 3: Write the implementation**

Three copy changes.

The connected state currently says events are **not** syncing, because when it was written they were not. That comment block in the file is explicit that copy implying sync "would leave an owner double-booked and trusting a calendar Callzie has never written to". Now the reverse is true, and stale copy would be the same failure pointed the other way.

Add the limitation ADR-0004 asks for: Callzie shows a conflict, it does not prevent one. There is no README yet — it is M7 — and this is where an owner will actually read it.

Add the seven-day line: connections made while the Google app is in Testing expire after a week and need reconnecting. An owner who hits that with no warning concludes the product is broken.

When `accessLostAt` is set, the not-connected state gets one extra sentence saying the connection expired or was revoked.

- [x] **Step 4: Verify**

---

## Task 14: Prove it against the real Google

**Files:**
- Create: `scripts/try-google.ts`
- Modify: `package.json`, `docs/verification.md`

- [x] **Step 1: Write the script**

The suite proves the pipeline against a fake. This proves the fake is right — the same split as `try-tools` and `try-extraction`. Follow `scripts/try-extraction.ts` for the `dotenv` loading, which has to happen before anything reads `process.env`.

It should, against the builder's own connected calendar:

1. Refresh a real access token and report `expires_in`.
2. Insert an event and print its id, so it can be seen in the Google UI.
3. List the window back and confirm the event is there.
4. Insert a deliberately overlapping event, run the detection, and confirm one Collision is found.
5. **Settle the open question:** insert a real all-day event, then query a *partial-day* window, and print whether Google returned it. This is the one thing the design routes around rather than relies on.
6. Patch the event to a new time, list again, confirm it moved.
7. Delete both, then delete one again and confirm the 410 is handled as success.
8. Clean up after itself, including on failure. A leftover event on a real calendar is worse than a failed script.

Add `"try-google": "tsx scripts/try-google.ts"` to `package.json`.

- [x] **Step 2: Run it**

`npm run try-google`. Free — the Calendar API costs nothing.

- [x] **Step 3: Record what it found**

Into `docs/verification.md`:

- The verified table from the design doc.
- **SPEC.md §13 item 4 is answered:** a Testing-status app is capped at 100 test users, and issues refresh tokens that expire after 7 days for any scope outside name/email/profile. Update SPEC.md's open-items list to point here.
- The all-day answer from step 5, marked as observed behaviour rather than documented behaviour, because Google does not document it.

- [x] **Step 4: Verify**

`npm test`, `npm run typecheck`, `npm run lint` — all clean.

---

## Acceptance criteria, mapped to tasks

| Criterion | Task |
|---|---|
| Connecting Google is optional and everything works without it | 3, 6 — early returns, asserted with a zero-HTTP-call test |
| A booking made in Callzie appears on the connected calendar | 4, 6, 9, 10 |
| A manually created overlapping Google event raises a Collision | 2, 5, 6, 7, 12 |
| A Collision marks the Appointment as needing attention and blocks calling | 5 — #15 already refuses to call a flagged Appointment |
| Nothing created in Google ever alters Callzie's Availability | Structural: no task adds a reader of Google to the Availability path |
| Token refresh works, and a revoked connection degrades to a designed state | 1, 3, 13 |

## Definition of done

- [x] `npm test` passes
- [x] `npm run typecheck` passes
- [x] `npm run lint` passes
- [x] `npm run try-google` succeeds and cleans up after itself
- [x] A booking made in the running app appears on the real calendar
- [x] A manually added overlapping event raises a Collision on Overview and marks the day on Schedule
- [x] Clearing that Collision holds across two reloads
- [x] With the three Google env vars removed, every screen behaves exactly as it does today
