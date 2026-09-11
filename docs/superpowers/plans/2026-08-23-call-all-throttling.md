# Call All — throttling and retry on no answer, Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One button queues every callable Appointment, three Calls run at a
time, an unanswered Call is tried once more, and a second silence leaves the
Appointment unreachable and needing attention with its Slot still held.

**Architecture:** The queue is a new `queued` Appointment status in Postgres.
A pump fills the free slots; it is called by the button, by every `call_ended`
webhook, and by a 5-second tick on the open page. The throttle is race-proof
because the claim runs inside a per-Business Postgres advisory lock with no
network call held inside it. Dialling sits behind a `CallPlacer` port whose only
implementation today refuses — #19 supplies the real one.

**Tech Stack:** Next.js 16 (App Router, Server Actions, `after()`), Drizzle ORM
on node-postgres, Vitest against a local Postgres started by
`vitest.globalSetup.ts`, React 19, Tailwind v4.

**Design:** `docs/superpowers/specs/2026-08-23-call-all-throttling-design.md`
**Issue:** [#17](https://github.com/anushapundir/callzie/issues/17)

---

## Before you start

Read `CLAUDE.md` first. Three things about this worktree will otherwise cost you
an afternoon:

- `npm test` needs only `node_modules`. `vitest.globalSetup.ts` starts its own
  Postgres and sets `DATABASE_URL`, so the whole suite runs with no secrets and
  no network. **Every test in this plan runs that way.**
- `npm run typecheck` needs Next's generated route types. On a fresh worktree run
  `npx next typegen` once, or you will see `Cannot find name 'PageProps'` in files
  nobody touched.
- `npm run replay-webhook` (Task 14 only) needs `.env.local` **and** the Cloud SQL
  Auth Proxy running. Everything before Task 14 does not.

Run a single test file with `npx vitest run <path>`. Test files run serially
(`fileParallelism: false`) because they share one Postgres.

**House rules that apply to every task:**

- Comments explain *why*, in plain English, and name the rule they come from
  (`SPEC.md §14 rule 2`, `docs/verification.md A10`). Match the density of the
  file you are editing.
- No `db` reads inside a transaction. The pool holds five connections; a function
  that reads through `db` while its caller is inside a transaction takes a second
  one and can deadlock the app (`lib/db/index.ts`). Pass `tx` down.
- A guard is a WHERE clause, never a read followed by a write.

---

## File structure

**New — `lib/calls/batch/`, six small modules with one job each**

| File | Responsibility | Imports a database? |
|---|---|---|
| `limits.ts` | The three constants, and why three is three | No — safe in a client bundle |
| `retry.ts` | What a finished Call earns: retry, unreachable, nothing | No |
| `summary.ts` | The sentences the confirmation sheet shows | No |
| `eligible.ts` | Which Appointments a batch may call; how much Quota is left | Yes |
| `in-flight.ts` | How many Calls are running right now | Yes |
| `queue.ts` | Every Appointment-status write the batch makes | Yes |
| `placer.ts` | The `CallPlacer` port, and the refusal behind it | Yes |
| `pump.ts` | Claim under the lock, then dial outside it | Yes |

**New — elsewhere**

- `lib/calls/reserve.ts` — the reserve half lifted out of `start-web-call.ts`
- `app/(app)/calls/batch-actions.ts` — four Server Actions
- `components/overview/call-all-button.tsx` — the button and its sheet (client)
- `components/overview/batch-strip.tsx` — the progress strip (client)
- `components/overview/batch-strip-view.tsx` — the strip's markup, pure and testable
- `docs/adr/0013-call-all-throttled-in-app-pumped-by-webhooks.md`

**Modified**

- `lib/db/schema.ts` — `queued` joins `APPOINTMENT_STATUSES`
- `lib/appointments/status-style.ts` — a colour and a word for it
- `lib/calls/start-web-call.ts` — uses `reserveCall`
- `lib/webhooks/process.ts` — the aftermath rule and the pump
- `app/(app)/page.tsx` — the button in the toolbar, the strip above the table
- `scripts/replay-webhook.ts` — the two-step no-answer chain
- `fixtures/retell/webhooks/README.md` — what that chain proves

**No migration.** `appointments.status` is a `text` column, and the
`appointments_no_overlap` constraint frees a Slot only for `declined` and
`cancelled` — so a new status holds its Slot without any SQL changing.

---

## Task 1: The `queued` Appointment status

**Files:**
- Modify: `lib/db/schema.ts:33-41`
- Modify: `lib/appointments/status-style.ts:37-46`
- Test: `lib/db/schema.test.ts` (add one case)

- [ ] **Step 1: Write the failing test**

Add to `lib/db/schema.test.ts`, inside the existing
`describe("SLOT_HOLDING_STATUSES")` block. That file already imports
`APPOINTMENT_STATUSES` and `SLOT_HOLDING_STATUSES` and needs no database.

```ts
  it("gives Call All somewhere to queue an Appointment", () => {
    /*
      A queued Appointment is waiting for a free slot in the throttle (issue
      #17). Nobody has said anything about the booking, so the Slot is still
      theirs — SPEC.md §14 rule 2, the same reason `unreachable` holds one.
    */
    expect(APPOINTMENT_STATUSES).toContain("queued");
    expect(SLOT_HOLDING_STATUSES).toContain("queued");
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/db/schema.test.ts`
Expected: FAIL — TypeScript rejects `"queued"`, because it is not in
`AppointmentStatus`.

The behavioural proof comes free: `lib/availability/find.test.ts` runs
`describe.each(APPOINTMENT_STATUSES)`, asserting each status either frees its
Slot or holds it against the real database. Adding to the list adds the case.

- [ ] **Step 3: Add the status**

In `lib/db/schema.ts`, put `queued` between `pending` and `calling` — the order
is the lifecycle:

```ts
export const APPOINTMENT_STATUSES = [
  "pending",
  /*
    Waiting for a free slot in the Call All throttle (issue #17).

    Note that `calls.status` also has a `queued`, and it means something
    adjacent but different: that a Call row exists and Retell has not been
    contacted yet. Both are "written down, not yet dialled", one about an
    Appointment and one about a Call.
  */
  "queued",
  "calling",
  "confirmed",
  "rescheduled",
  "declined",
  "cancelled",
  "unreachable",
] as const;
```

`SLOT_HOLDING_STATUSES` is derived from this list by filtering out `declined`
and `cancelled`, so it picks `queued` up with no edit.

- [ ] **Step 4: Give it a colour**

In `lib/appointments/status-style.ts`, add to `STATUS_STYLES`:

```ts
  // Muted like `pending`, and for the same reason: a queued Appointment is
  // waiting rather than happening, and should not draw the eye away from the
  // row that is actually being called.
  queued: { background: "bg-text-muted", label: "Queued" },
```

This file is a `Record<AppointmentStatus, StatusStyle>`, so it will not compile
until the entry exists. That is the intended safety net, not an accident.

- [ ] **Step 5: Run the tests and the typechecker**

Run: `npx vitest run lib/db/schema.test.ts lib/availability/find.test.ts lib/schedule`
Expected: PASS, including a new `an Appointment with status queued` case in
`find.test.ts` proving the Slot is still blocked against the real database.
`schema.test.ts` also parses the migration to check the slot-freeing list still
matches the constraint; it must stay green.

Run: `npm run typecheck`
Expected: no errors. (Run `npx next typegen` first on a fresh worktree.)

- [ ] **Step 6: Commit**

```bash
git add lib/db/schema.ts lib/db/schema.test.ts lib/appointments/status-style.ts
git commit -m "Give an Appointment somewhere to wait, without freeing its Slot"
```

---

## Task 2: The three limits, in one place

**Files:**
- Create: `lib/calls/batch/limits.ts`

No test — these are constants, and the tests that matter assert the behaviour
they produce. The file exists so that nothing importing a limit has to import a
module that touches the database: `summary.ts` and the client components below
both read `MAX_CONCURRENT_CALLS`, and pulling `pump.ts` into the browser bundle
would break the build.

- [ ] **Step 1: Write the file**

```ts
/*
  The three numbers Call All is bounded by (issue #17).

  They live alone, with no database import, so a client component can read
  MAX_CONCURRENT_CALLS without dragging `pg` into the browser bundle.
*/

/**
 * How many Calls Callzie will run at once.
 *
 * **This is a cost and pacing decision, not a platform limit.** A Retell
 * Pay-As-You-Go workspace is allowed twenty concurrent Calls and the first
 * twenty are free (`docs/verification.md` A10). Three is what keeps a demo
 * watchable and a five-Call Quota from vanishing in one press.
 *
 * The README owes this sentence — SPEC.md §12's M7 deliverable, tracked on
 * issue #21 — because "we cap at three" reads as a platform constraint unless
 * it says otherwise. See ADR-0013.
 */
export const MAX_CONCURRENT_CALLS = 3;

/**
 * How many Appointments one press may queue.
 *
 * A bound on the shape of a request rather than a product rule, matching
 * `MAX_CSV_ROWS`. The Quota is the real limit for every account that is not an
 * admin; this stops an admin's single press from queueing a thousand rows.
 */
export const MAX_BATCH_SIZE = 200;

/**
 * Attempts before an Appointment is declared unreachable.
 *
 * Two: the first Call, and the one retry issue #17 asks for.
 */
export const MAX_ATTEMPTS = 2;
```

- [ ] **Step 2: Commit**

```bash
git add lib/calls/batch/limits.ts
git commit -m "Write down why Call All stops at three, where nobody can miss it"
```

---

## Task 3: What a finished Call earns

**Files:**
- Create: `lib/calls/batch/retry.ts`
- Test: `lib/calls/batch/retry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { afterCall } from "@/lib/calls/batch/retry";

/*
  SPEC.md §14 rule 2 in one function: an unanswered phone is not a
  cancellation. One retry, then a human.

  Pure, so every case is a line — the same shape as lib/calls/truncation.ts,
  and for the same reason: the judgement is worth pinning separately from the
  writes it triggers.
*/

describe("afterCall", () => {
  it("retries the first silence", () => {
    expect(afterCall({ status: "no_answer", attempt: 1 })).toBe("retry");
  });

  it("gives up after the second", () => {
    expect(afterCall({ status: "no_answer", attempt: 2 })).toBe("unreachable");
  });

  it("gives up rather than looping if an attempt somehow got past two", () => {
    expect(afterCall({ status: "no_answer", attempt: 3 })).toBe("unreachable");
  });

  it("does nothing for a Call that connected", () => {
    expect(afterCall({ status: "completed", attempt: 1 })).toBe("nothing");
  });

  it("does nothing for a failure, which is not a silence", () => {
    // `error_user_not_joined` and `no_valid_payment` both map to `failed`
    // (docs/verification.md A9). Neither means nobody picked up the phone.
    expect(afterCall({ status: "failed", attempt: 1 })).toBe("nothing");
  });

  it("does nothing for a Call that has not finished", () => {
    expect(afterCall({ status: "in_progress", attempt: 1 })).toBe("nothing");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/calls/batch/retry.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/calls/batch/retry"`.

- [ ] **Step 3: Write the implementation**

```ts
import { MAX_ATTEMPTS } from "@/lib/calls/batch/limits";
import type { CallStatus } from "@/lib/db/schema";

/**
 * What a finished Call leaves behind (issue #17).
 *
 * `retry` means the Appointment goes back in the queue and gets one more Call.
 * `unreachable` means it stops and waits for a human — **keeping its Slot**,
 * because an unanswered phone is not a cancellation (SPEC.md §14 rule 2).
 *
 * Only `no_answer` earns either. `failed` covers a broken Web Call token and an
 * empty Retell balance (`docs/verification.md` A9), and neither says anything
 * about whether the person would have picked up.
 */
export type CallAftermath = "retry" | "unreachable" | "nothing";

export function afterCall({
  status,
  attempt,
}: {
  status: CallStatus;
  attempt: number;
}): CallAftermath {
  if (status !== "no_answer") return "nothing";
  return attempt < MAX_ATTEMPTS ? "retry" : "unreachable";
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run lib/calls/batch/retry.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/calls/batch/retry.ts lib/calls/batch/retry.test.ts
git commit -m "Decide once what an unanswered Call earns"
```

---

## Task 4: The sentences the confirmation shows

**Files:**
- Create: `lib/calls/batch/summary.ts`
- Test: `lib/calls/batch/summary.test.ts`

The sheet spends every Call the account has left, so its wording is worth
testing. Keeping it a pure function follows `lib/calls/no-tools.ts` and
`lib/calls/failure-reason.ts`, which do the same for the Call detail screen.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { batchSummary } from "@/lib/calls/batch/summary";

/*
  What the Call all sheet says before it spends anything.

  Four refusals and two invitations. The numbers are the point: a sheet that
  said "Call 8 people?" while the Quota allowed three would be lying at the
  moment the person decides.
*/

describe("batchSummary", () => {
  it("refuses when the account cannot place Phone Calls", () => {
    const summary = batchSummary({
      eligible: 8,
      quotaRemaining: 5,
      phoneCallsEnabled: false,
    });

    expect(summary.canStart).toBe(false);
    expect(summary.title).toBe("Phone calls are off for this account");
  });

  it("refuses when there is nobody to call", () => {
    const summary = batchSummary({
      eligible: 0,
      quotaRemaining: 5,
      phoneCallsEnabled: true,
    });

    expect(summary.canStart).toBe(false);
    expect(summary.title).toBe("No appointments to call");
  });

  it("refuses when the Quota is spent", () => {
    const summary = batchSummary({
      eligible: 8,
      quotaRemaining: 0,
      phoneCallsEnabled: true,
    });

    expect(summary.canStart).toBe(false);
    expect(summary.title).toBe("You've used all your calls");
  });

  it("says how many will actually be placed when the Quota is smaller", () => {
    const summary = batchSummary({
      eligible: 8,
      quotaRemaining: 3,
      phoneCallsEnabled: true,
    });

    expect(summary.canStart).toBe(true);
    expect(summary.willPlace).toBe(3);
    expect(summary.title).toBe("Call 3 of 8 people?");
    expect(summary.detail).toBe(
      "You have 3 calls left, so 3 will be placed and 5 stay pending. " +
        "Callzie calls at most 3 at a time.",
    );
  });

  it("calls everybody when the Quota allows it", () => {
    const summary = batchSummary({
      eligible: 4,
      quotaRemaining: 5,
      phoneCallsEnabled: true,
    });

    expect(summary.willPlace).toBe(4);
    expect(summary.title).toBe("Call 4 people?");
    expect(summary.detail).toBe("Callzie calls at most 3 at a time.");
  });

  it("says person, not people, for one", () => {
    const summary = batchSummary({
      eligible: 1,
      quotaRemaining: 5,
      phoneCallsEnabled: true,
    });

    expect(summary.title).toBe("Call 1 person?");
  });

  it("treats an unlimited Quota as no bound at all", () => {
    // An admin account. `quotaRemaining` is null rather than a number, because
    // Infinity does not survive the trip from the server (SPEC.md §11.1).
    const summary = batchSummary({
      eligible: 40,
      quotaRemaining: null,
      phoneCallsEnabled: true,
    });

    expect(summary.willPlace).toBe(40);
    expect(summary.title).toBe("Call 40 people?");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/calls/batch/summary.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/calls/batch/summary"`.

- [ ] **Step 3: Write the implementation**

```ts
import { MAX_BATCH_SIZE, MAX_CONCURRENT_CALLS } from "@/lib/calls/batch/limits";

/**
 * What the Call all sheet says, and whether its button does anything.
 *
 * Pure, and tested, because this is the moment somebody decides to spend every
 * Call their account has left. A refusal here is written as a sentence rather
 * than a disabled control with no explanation — SPEC.md §11.4, and the same
 * rule `components/calls/call-now-button.tsx` follows.
 *
 * `quotaRemaining` is `null` for an admin account, meaning unlimited. It is not
 * `Infinity`: this value crosses from a Server Action to the browser as JSON,
 * and `JSON.stringify(Infinity)` is `null` anyway.
 */
export type BatchSummary = {
  title: string;
  detail: string;
  /** How many Calls pressing the button would actually place. */
  willPlace: number;
  canStart: boolean;
};

export function batchSummary({
  eligible,
  quotaRemaining,
  phoneCallsEnabled,
}: {
  eligible: number;
  quotaRemaining: number | null;
  phoneCallsEnabled: boolean;
}): BatchSummary {
  const pacing = `Callzie calls at most ${MAX_CONCURRENT_CALLS} at a time.`;

  /*
    First, because it is the one refusal that is about the account rather than
    about the work. SPEC.md §3 rule 9: signups get Web Calls, and a Web Call
    needs a browser to join it — which is why Call All cannot use one.
  */
  if (!phoneCallsEnabled) {
    return {
      title: "Phone calls are off for this account",
      detail:
        "Callzie places web calls from this browser, one at a time. " +
        "Call all needs the phone path.",
      willPlace: 0,
      canStart: false,
    };
  }

  if (eligible === 0) {
    return {
      title: "No appointments to call",
      detail:
        "Every appointment here is already handled, needs attention, or has " +
        "already happened.",
      willPlace: 0,
      canStart: false,
    };
  }

  if (quotaRemaining === 0) {
    return {
      title: "You've used all your calls",
      detail: "Nothing will be placed until the quota is raised.",
      willPlace: 0,
      canStart: false,
    };
  }

  const willPlace = Math.min(
    eligible,
    quotaRemaining ?? eligible,
    MAX_BATCH_SIZE,
  );

  if (willPlace < eligible) {
    return {
      title: `Call ${willPlace} of ${eligible} people?`,
      detail:
        `You have ${quotaRemaining} calls left, so ${willPlace} will be ` +
        `placed and ${eligible - willPlace} stay pending. ${pacing}`,
      willPlace,
      canStart: true,
    };
  }

  return {
    title: `Call ${eligible} ${eligible === 1 ? "person" : "people"}?`,
    detail: pacing,
    willPlace,
    canStart: true,
  };
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run lib/calls/batch/summary.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/calls/batch/summary.ts lib/calls/batch/summary.test.ts
git commit -m "Say exactly how many calls the button is about to spend"
```

---

## Task 5: Lift the reserve half out of `startWebCall`

**Files:**
- Create: `lib/calls/reserve.ts`
- Test: `lib/calls/reserve.test.ts`
- Modify: `lib/calls/start-web-call.ts:142-176`

The pump needs "count the prior Calls, claim the Quota, insert the row" inside
*its* transaction. `startWebCall` already does exactly that inside its own. Two
copies would drift, and the thing that drifts is the attempt number.

- [ ] **Step 1: Write the failing test**

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { reserveCall } from "@/lib/calls/reserve";
import { db, schema } from "@/lib/db";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

/*
  The half of placing a Call that must happen in one transaction: the attempt
  number, the Quota claim and the `calls` row land together or not at all. A
  claimed Call with no row charges somebody for nothing; a row with no claim
  gives a Call away.
*/

const CLERK_ID = "user_test_calls_reserve";
const STARTS_AT = new Date("2026-09-14T04:30:00.000Z");

let seed: ToolTestSeed;

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({ clerkId: CLERK_ID, appointmentStartsAt: STARTS_AT });
});

afterEach(() => cleanupToolTest(CLERK_ID));

async function reserve() {
  return db.transaction((tx) =>
    reserveCall(tx, {
      businessId: seed.businessId,
      appointmentId: seed.appointmentId,
      callType: "phone",
    }),
  );
}

describe("reserveCall", () => {
  it("numbers the next attempt after the Calls already there", async () => {
    // The seed leaves one Call behind, so this is the second attempt.
    const result = await reserve();

    expect(result).toMatchObject({ ok: true, attempt: 2 });
  });

  it("writes the row queued, before Retell is contacted", async () => {
    const result = await reserve();
    if (!result.ok) throw new Error("expected a reservation");

    const call = await db.query.calls.findFirst({
      where: eq(schema.calls.id, result.callId),
    });

    expect(call?.status).toBe("queued");
    expect(call?.callType).toBe("phone");
    expect(call?.retellCallId).toBeNull();
  });

  it("spends one Call from the Quota", async () => {
    await reserve();

    const business = await db.query.businesses.findFirst({
      where: eq(schema.businesses.id, seed.businessId),
    });

    expect(business?.callsUsed).toBe(1);
  });

  it("refuses, and writes nothing, once the Quota is spent", async () => {
    await db
      .update(schema.businesses)
      .set({ callsUsed: 5, callQuota: 5 })
      .where(eq(schema.businesses.id, seed.businessId));

    const before = await db
      .select()
      .from(schema.calls)
      .where(eq(schema.calls.appointmentId, seed.appointmentId));

    expect(await reserve()).toEqual({ ok: false, reason: "exhausted" });

    const after = await db
      .select()
      .from(schema.calls)
      .where(eq(schema.calls.appointmentId, seed.appointmentId));
    expect(after.length).toBe(before.length);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/calls/reserve.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/calls/reserve"`.

- [ ] **Step 3: Write `lib/calls/reserve.ts`**

```ts
import { count, eq } from "drizzle-orm";

import { claimCallQuota, type Executor } from "@/lib/calls/quota";
import { schema } from "@/lib/db";
import type { CallType } from "@/lib/db/schema";

/*
  Everything about placing a Call that has to be atomic.

  Lifted out of lib/calls/start-web-call.ts when issue #17's batch pump needed
  the same three writes inside its own transaction. Two copies of this would
  drift, and the thing that drifts is the attempt number — which is what the
  Call detail screen renders as "2 of 2" and what the retry rule reads.

  Takes an executor rather than reaching for `db`, so the caller decides the
  transaction. The count MUST be inside it: two concurrent Calls for one
  Appointment would otherwise both come out as attempt 2.
*/

export type ReserveResult =
  | { ok: true; callId: string; attempt: number }
  | { ok: false; reason: "exhausted" };

export async function reserveCall(
  executor: Executor,
  {
    businessId,
    appointmentId,
    callType,
  }: { businessId: string; appointmentId: string; callType: CallType },
): Promise<ReserveResult> {
  const [{ existing }] = await executor
    .select({ existing: count() })
    .from(schema.calls)
    .where(eq(schema.calls.appointmentId, appointmentId));

  const claim = await claimCallQuota(executor, businessId);
  if (!claim.ok) return { ok: false, reason: "exhausted" };

  const attempt = existing + 1;

  const [call] = await executor
    .insert(schema.calls)
    .values({ appointmentId, callType, attempt, status: "queued" })
    .returning({ id: schema.calls.id });

  return { ok: true, callId: call.id, attempt };
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run lib/calls/reserve.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Make `startWebCall` use it**

In `lib/calls/start-web-call.ts`, replace the body of the `db.transaction`
callback. Delete the `count` import if nothing else uses it, and add
`import { reserveCall } from "@/lib/calls/reserve";`.

```ts
  let callId: string;
  try {
    callId = await db.transaction(async (tx) => {
      /*
        The claim and the Call row land together or not at all — see
        lib/calls/reserve.ts, which issue #17's batch pump shares.
      */
      const reserved = await reserveCall(tx, {
        businessId,
        appointmentId,
        callType: "web",
      });
      if (!reserved.ok) throw new QuotaExhausted();

      return reserved.callId;
    });
  } catch (error) {
    if (error instanceof QuotaExhausted) {
      return { ok: false, reason: "exhausted", message: MESSAGES.exhausted };
    }
    throw error;
  }
```

- [ ] **Step 6: Run the Web Call suite to prove nothing moved**

Run: `npx vitest run lib/calls/start-web-call.test.ts lib/calls/reserve.test.ts`
Expected: PASS. `start-web-call.test.ts` already covers the attempt number and
the exhausted Quota; it must stay green without being edited.

- [ ] **Step 7: Commit**

```bash
git add lib/calls/reserve.ts lib/calls/reserve.test.ts lib/calls/start-web-call.ts
git commit -m "Share one reservation between the Web Call and the batch"
```

---

## Task 6: Who a batch may call

**Files:**
- Create: `lib/calls/batch/eligible.ts`
- Test: `lib/calls/batch/eligible.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eligibleAppointmentIds, quotaRemaining } from "@/lib/calls/batch/eligible";
import { db, schema } from "@/lib/db";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

/*
  "Call All queues every pending Appointment" and "Appointments needing
  attention are skipped" — issue #17's first two acceptance criteria, and #15's
  third.
*/

const CLERK_ID = "user_test_batch_eligible";
const NOW = new Date("2026-09-01T00:00:00.000Z");
const FUTURE = new Date("2026-09-14T04:30:00.000Z");

let seed: ToolTestSeed;

/** A second Appointment for the same Business, parked clear of the seeded one. */
async function addAppointment(
  startsAt: Date,
  values: Partial<typeof schema.appointments.$inferInsert> = {},
) {
  const [row] = await db
    .insert(schema.appointments)
    .values({
      businessId: seed.businessId,
      serviceId: seed.serviceId,
      name: "Second Person",
      phoneE164: "+919876543211",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
      status: "pending",
      ...values,
    })
    .returning();
  return row;
}

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({ clerkId: CLERK_ID, appointmentStartsAt: FUTURE });
  // The seed leaves its Appointment `calling`; a batch only takes pending ones.
  await db
    .update(schema.appointments)
    .set({ status: "pending" })
    .where(eq(schema.appointments.id, seed.appointmentId));
});

afterEach(() => cleanupToolTest(CLERK_ID));

describe("eligibleAppointmentIds", () => {
  it("takes a pending Appointment in the future", async () => {
    expect(await eligibleAppointmentIds(seed.businessId, NOW)).toEqual([
      seed.appointmentId,
    ]);
  });

  it("skips an Appointment that needs attention", async () => {
    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: "book_failed" })
      .where(eq(schema.appointments.id, seed.appointmentId));

    expect(await eligibleAppointmentIds(seed.businessId, NOW)).toEqual([]);
  });

  it("skips an Appointment that has already happened", async () => {
    const past = new Date("2026-08-01T04:30:00.000Z");
    await addAppointment(past);

    expect(await eligibleAppointmentIds(seed.businessId, NOW)).toEqual([
      seed.appointmentId,
    ]);
  });

  it("skips anything already settled", async () => {
    await db
      .update(schema.appointments)
      .set({ status: "confirmed" })
      .where(eq(schema.appointments.id, seed.appointmentId));

    expect(await eligibleAppointmentIds(seed.businessId, NOW)).toEqual([]);
  });

  it("calls the soonest Appointment first", async () => {
    const sooner = await addAppointment(new Date("2026-09-07T04:30:00.000Z"));

    expect(await eligibleAppointmentIds(seed.businessId, NOW)).toEqual([
      sooner.id,
      seed.appointmentId,
    ]);
  });

  it("never sees another Business's Appointments", async () => {
    expect(
      await eligibleAppointmentIds("00000000-0000-0000-0000-000000000000", NOW),
    ).toEqual([]);
  });
});

describe("quotaRemaining", () => {
  it("is what is left of the Quota", async () => {
    await db
      .update(schema.businesses)
      .set({ callsUsed: 2, callQuota: 5 })
      .where(eq(schema.businesses.id, seed.businessId));

    expect(await quotaRemaining(seed.businessId)).toBe(3);
  });

  it("floors at zero rather than going negative", async () => {
    await db
      .update(schema.businesses)
      .set({ callsUsed: 9, callQuota: 5 })
      .where(eq(schema.businesses.id, seed.businessId));

    expect(await quotaRemaining(seed.businessId)).toBe(0);
  });

  it("is unlimited for an admin", async () => {
    await db
      .update(schema.businesses)
      .set({ isAdmin: true, callsUsed: 99, callQuota: 5 })
      .where(eq(schema.businesses.id, seed.businessId));

    expect(await quotaRemaining(seed.businessId)).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/calls/batch/eligible.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/calls/batch/eligible"`.

- [ ] **Step 3: Write the implementation**

```ts
import { and, asc, eq, gt, isNull } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/*
  Which Appointments Call All may call (issue #17), and how much Quota is left
  to call them with.
*/

/**
 * The callable Appointments, soonest first.
 *
 * Three conditions, each earning its place:
 *
 * - `pending` — anything confirmed, rescheduled, declined or cancelled has an
 *   answer already, and anything `queued` or `calling` is in this batch.
 * - no `needs_attention_reason` — an Appointment carrying one is blocked from
 *   calling until a human clears it (issue #15). That is also what skips an
 *   `unreachable` one, which always carries the matching reason.
 * - `starts_at` in the future — phoning somebody to confirm a time that has
 *   already passed spends a Call on something that cannot change.
 *
 * Scoped to the Business inside the WHERE clause, never checked after the read.
 *
 * `now` is injected, matching lib/availability/slots.ts and
 * lib/business/active-calls.ts, so a test does not depend on the clock it runs
 * at.
 */
export async function eligibleAppointmentIds(
  businessId: string,
  now: Date = new Date(),
): Promise<string[]> {
  const rows = await db
    .select({ id: schema.appointments.id })
    .from(schema.appointments)
    .where(
      and(
        eq(schema.appointments.businessId, businessId),
        eq(schema.appointments.status, "pending"),
        isNull(schema.appointments.needsAttentionReason),
        gt(schema.appointments.startsAt, now),
      ),
    )
    .orderBy(asc(schema.appointments.startsAt));

  return rows.map((row) => row.id);
}

/**
 * How many Calls the Quota still allows — a **preview**, not a guarantee.
 *
 * The real bound is `claimCallQuota`'s single UPDATE, and this number can be
 * stale the instant it is read: another tab pressing "Call now" moves it. It
 * exists so the confirmation sheet can say something true at the moment it
 * opens, and so a batch does not queue rows it can never place.
 *
 * `Infinity` for an admin account, which has no bound (SPEC.md §11.1). Callers
 * that send this to the browser turn it into `null` first.
 */
export async function quotaRemaining(businessId: string): Promise<number> {
  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.id, businessId),
    columns: { callQuota: true, callsUsed: true, isAdmin: true },
  });

  if (!business) return 0;
  if (business.isAdmin) return Number.POSITIVE_INFINITY;

  return Math.max(0, business.callQuota - business.callsUsed);
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run lib/calls/batch/eligible.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/calls/batch/eligible.ts lib/calls/batch/eligible.test.ts
git commit -m "Decide who a batch is allowed to phone"
```

---

## Task 7: How many Calls are running

**Files:**
- Create: `lib/calls/batch/in-flight.ts`
- Test: `lib/calls/batch/in-flight.test.ts`

Two callers need this number and they need it filtered differently, so it lives
alone: the throttle counts Calls of every type, and the progress strip counts
only Phone Calls.

- [ ] **Step 1: Write the failing test**

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { countInFlightCalls } from "@/lib/calls/batch/in-flight";
import { db, schema } from "@/lib/db";
import type { CallStatus, CallType } from "@/lib/db/schema";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

/*
  What "running right now" means, which is not the same as what the status
  column says. A Call cannot outlive max_call_duration_ms (SPEC.md §7), so a row
  still marked in_progress three minutes later is a delivery that never arrived,
  not a Call — and it must not hold a slot in the throttle for the life of the
  account. Same read-time staleness rule as lib/business/active-calls.ts.
*/

const CLERK_ID = "user_test_batch_in_flight";
const NOW = new Date("2026-09-01T00:00:00.000Z");
const STARTS_AT = new Date("2026-09-14T04:30:00.000Z");

let seed: ToolTestSeed;

async function addCall(
  status: CallStatus,
  callType: CallType,
  createdAt: Date = NOW,
) {
  await db.insert(schema.calls).values({
    appointmentId: seed.appointmentId,
    callType,
    status,
    createdAt,
  });
}

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({ clerkId: CLERK_ID, appointmentStartsAt: STARTS_AT });
  // The seed's own Call would count; clear it so each case starts from zero.
  await db.delete(schema.calls).where(eq(schema.calls.id, seed.callId));
});

afterEach(() => cleanupToolTest(CLERK_ID));

describe("countInFlightCalls", () => {
  it("counts a Call that has not connected yet", async () => {
    await addCall("queued", "phone");

    expect(await countInFlightCalls(db, seed.businessId, NOW)).toBe(1);
  });

  it("counts a Call that is ringing or in progress", async () => {
    await addCall("ringing", "phone");
    await addCall("in_progress", "phone");

    expect(await countInFlightCalls(db, seed.businessId, NOW)).toBe(2);
  });

  it("does not count a Call that has finished", async () => {
    await addCall("completed", "phone");
    await addCall("no_answer", "phone");
    await addCall("failed", "phone");

    expect(await countInFlightCalls(db, seed.businessId, NOW)).toBe(0);
  });

  it("does not count a Call too old to still be running", async () => {
    // Three minutes and one second: past the 120s cap plus its slack.
    await addCall("in_progress", "phone", new Date(NOW.getTime() - 181_000));

    expect(await countInFlightCalls(db, seed.businessId, NOW)).toBe(0);
  });

  it("counts a live Web Call, because it is one of the account's Calls", async () => {
    await addCall("in_progress", "web");

    expect(await countInFlightCalls(db, seed.businessId, NOW)).toBe(1);
  });

  it("can be asked for Phone Calls only, which is what the strip shows", async () => {
    await addCall("in_progress", "web");
    await addCall("in_progress", "phone");

    expect(await countInFlightCalls(db, seed.businessId, NOW, ["phone"])).toBe(1);
  });

  it("never counts another Business's Calls", async () => {
    await addCall("in_progress", "phone");

    expect(
      await countInFlightCalls(db, "00000000-0000-0000-0000-000000000000", NOW),
    ).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/calls/batch/in-flight.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/calls/batch/in-flight"`.

- [ ] **Step 3: Write the implementation**

```ts
import { and, count, eq, gt, inArray } from "drizzle-orm";

import { LIVE_CALL_STALENESS_MS } from "@/lib/business/active-calls";
import type { Executor } from "@/lib/calls/quota";
import { schema } from "@/lib/db";
import { CALL_TYPES, type CallStatus, type CallType } from "@/lib/db/schema";

/*
  How many Calls this Business has running (issue #17's throttle).

  Distinct from lib/business/active-calls.ts, which answers "is a conversation
  happening" for the pulsing dot and the row shimmer. This one also counts a
  Call that has been reserved and not yet connected, because a slot in the
  throttle is taken from the moment the row is written — otherwise three Calls
  ringing at once would count as zero and the pump would place three more.
*/

/** Statuses where the Call has not finished happening. */
const IN_FLIGHT: readonly CallStatus[] = ["queued", "ringing", "in_progress"];

/**
 * Counts the Calls in flight, at this moment.
 *
 * Takes an executor rather than reaching for `db`, because the pump calls this
 * from inside its transaction and a second connection there can deadlock the
 * pool (`lib/db/index.ts`).
 *
 * The recency condition is not decoration. A Call cannot outlive
 * `max_call_duration_ms` (SPEC.md §7), so a row older than that plus slack is a
 * delivery that never arrived rather than a Call. Deciding that at read time
 * means no background job to schedule and nothing that can itself fail and
 * leave a slot held forever. Note it does NOT correct the row: rewriting
 * history from a guess is how a Call's record stops being a record.
 */
export async function countInFlightCalls(
  executor: Executor,
  businessId: string,
  now: Date = new Date(),
  callTypes: readonly CallType[] = CALL_TYPES,
): Promise<number> {
  const [row] = await executor
    .select({ n: count() })
    .from(schema.calls)
    // Scoped through `appointments`, because `calls` carries no business_id.
    .innerJoin(
      schema.appointments,
      eq(schema.calls.appointmentId, schema.appointments.id),
    )
    .where(
      and(
        eq(schema.appointments.businessId, businessId),
        inArray(schema.calls.status, [...IN_FLIGHT]),
        inArray(schema.calls.callType, [...callTypes]),
        gt(
          schema.calls.createdAt,
          new Date(now.getTime() - LIVE_CALL_STALENESS_MS),
        ),
      ),
    );

  return row.n;
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run lib/calls/batch/in-flight.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/calls/batch/in-flight.ts lib/calls/batch/in-flight.test.ts
git commit -m "Count the Calls that are actually running, not the ones that look it"
```

---

## Task 8: The queue's writes

**Files:**
- Create: `lib/calls/batch/queue.ts`
- Test: `lib/calls/batch/queue.test.ts`

Every Appointment-status write the batch makes lives here: joining the queue,
leaving it, being requeued for a retry, and going unreachable.

- [ ] **Step 1: Write the failing test**

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  batchProgress,
  enqueueBatch,
  markUnreachable,
  requeueForRetry,
  stopBatch,
} from "@/lib/calls/batch/queue";
import { db, schema } from "@/lib/db";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

/*
  The queue, and the two writes a finished Call triggers.

  The rule these tests exist for is the last one: an unreachable Appointment
  keeps its Slot and its time (SPEC.md §14 rule 2). Freeing a Slot because
  nobody picked up the phone would destroy a real booking on the weakest signal
  available.
*/

const CLERK_ID = "user_test_batch_queue";
const NOW = new Date("2026-09-01T00:00:00.000Z");
const STARTS_AT = new Date("2026-09-14T04:30:00.000Z");

let seed: ToolTestSeed;

async function addAppointment(startsAt: Date) {
  const [row] = await db
    .insert(schema.appointments)
    .values({
      businessId: seed.businessId,
      serviceId: seed.serviceId,
      name: "Second Person",
      phoneE164: "+919876543211",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
      status: "pending",
    })
    .returning();
  return row;
}

async function appointment(id: string = seed.appointmentId) {
  return db.query.appointments.findFirst({
    where: eq(schema.appointments.id, id),
  });
}

async function setStatus(status: string, id: string = seed.appointmentId) {
  await db
    .update(schema.appointments)
    .set({ status: status as "pending" })
    .where(eq(schema.appointments.id, id));
}

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({ clerkId: CLERK_ID, appointmentStartsAt: STARTS_AT });
  await setStatus("pending");
});

afterEach(() => cleanupToolTest(CLERK_ID));

describe("enqueueBatch", () => {
  it("queues every callable Appointment", async () => {
    await addAppointment(new Date("2026-09-15T04:30:00.000Z"));

    expect(await enqueueBatch({ businessId: seed.businessId, now: NOW })).toEqual({
      queued: 2,
      eligible: 2,
    });
    expect((await appointment())?.status).toBe("queued");
  });

  it("queues no more than the Quota allows", async () => {
    await addAppointment(new Date("2026-09-15T04:30:00.000Z"));
    await addAppointment(new Date("2026-09-16T04:30:00.000Z"));
    await db
      .update(schema.businesses)
      .set({ callsUsed: 4, callQuota: 5 })
      .where(eq(schema.businesses.id, seed.businessId));

    // Issue #17: the Quota is respected across the whole batch, not per Call.
    expect(await enqueueBatch({ businessId: seed.businessId, now: NOW })).toEqual({
      queued: 1,
      eligible: 3,
    });
  });

  it("queues nothing twice, so a double press is harmless", async () => {
    await enqueueBatch({ businessId: seed.businessId, now: NOW });

    expect(await enqueueBatch({ businessId: seed.businessId, now: NOW })).toEqual({
      queued: 0,
      eligible: 0,
    });
  });
});

describe("stopBatch", () => {
  it("returns the waiting Appointments to pending", async () => {
    await enqueueBatch({ businessId: seed.businessId, now: NOW });

    expect(await stopBatch(seed.businessId)).toBe(1);
    expect((await appointment())?.status).toBe("pending");
  });

  it("leaves a Call already in flight alone", async () => {
    await setStatus("calling");

    expect(await stopBatch(seed.businessId)).toBe(0);
    expect((await appointment())?.status).toBe("calling");
  });
});

describe("requeueForRetry", () => {
  it("puts the Appointment back in the queue", async () => {
    await requeueForRetry(seed.appointmentId);

    expect((await appointment())?.status).toBe("queued");
  });

  it("leaves an outcome a Tool committed alone", async () => {
    // The Tool wins (SPEC.md §9 step 3). A confirmed Appointment must never be
    // dragged back into a queue by a late webhook.
    await setStatus("confirmed");

    await requeueForRetry(seed.appointmentId);

    expect((await appointment())?.status).toBe("confirmed");
  });

  it("refuses an Appointment that needs attention", async () => {
    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: "book_failed" })
      .where(eq(schema.appointments.id, seed.appointmentId));

    await requeueForRetry(seed.appointmentId);

    expect((await appointment())?.status).toBe("pending");
  });
});

describe("markUnreachable", () => {
  it("stops calling and asks for a human", async () => {
    await markUnreachable(seed.appointmentId);

    const row = await appointment();
    expect(row?.status).toBe("unreachable");
    expect(row?.needsAttentionReason).toBe("unreachable");
  });

  it("keeps the Slot, which is the whole point", async () => {
    // SPEC.md §14 rule 2. `unreachable` is not in SLOT_FREEING_STATUSES, and
    // the time itself must not move either.
    await markUnreachable(seed.appointmentId);

    expect((await appointment())?.startsAt.getTime()).toBe(STARTS_AT.getTime());
  });

  it("does not overwrite a more specific reason", async () => {
    // `book_failed` says the Call tried to book and could not, which is more
    // than "nobody answered". The same rule flagTruncated follows.
    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: "book_failed" })
      .where(eq(schema.appointments.id, seed.appointmentId));

    await markUnreachable(seed.appointmentId);

    const row = await appointment();
    expect(row?.status).toBe("unreachable");
    expect(row?.needsAttentionReason).toBe("book_failed");
  });

  it("is a no-op on a delivery that arrives twice", async () => {
    await markUnreachable(seed.appointmentId);
    await markUnreachable(seed.appointmentId);

    expect((await appointment())?.needsAttentionReason).toBe("unreachable");
  });
});

describe("batchProgress", () => {
  it("counts what is waiting and what is being called", async () => {
    const second = await addAppointment(new Date("2026-09-15T04:30:00.000Z"));
    await enqueueBatch({ businessId: seed.businessId, now: NOW });
    await setStatus("calling", second.id);
    await db.insert(schema.calls).values({
      appointmentId: second.id,
      callType: "phone",
      status: "in_progress",
      createdAt: NOW,
    });

    expect(await batchProgress(seed.businessId, NOW)).toEqual({
      calling: 1,
      waiting: 1,
    });
  });

  it("does not count a live Web Call, which the live-call bar already shows", async () => {
    await db.insert(schema.calls).values({
      appointmentId: seed.appointmentId,
      callType: "web",
      status: "in_progress",
      createdAt: NOW,
    });

    expect(await batchProgress(seed.businessId, NOW)).toEqual({
      calling: 0,
      waiting: 0,
    });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/calls/batch/queue.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/calls/batch/queue"`.

- [ ] **Step 3: Write the implementation**

```ts
import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  eligibleAppointmentIds,
  quotaRemaining,
} from "@/lib/calls/batch/eligible";
import { countInFlightCalls } from "@/lib/calls/batch/in-flight";
import { MAX_BATCH_SIZE } from "@/lib/calls/batch/limits";
import { db, schema } from "@/lib/db";

/*
  Every Appointment-status write the batch makes (issue #17).

  Four of them, and all four are conditional UPDATEs writing fixed values. That
  is what makes them safe against a webhook delivered twice and against two
  pumps running at once — the same property lib/webhooks/process.ts states about
  itself. Never a read followed by a write.
*/

/**
 * Marks the callable Appointments as waiting for a Call.
 *
 * **Capped at the remaining Quota**, which is what lets the confirmation sheet
 * say "3 will be placed and 5 stay pending" and be right. Queueing all eight
 * was considered and rejected: an Appointment that can never be placed is a row
 * lying about what is going to happen.
 *
 * The claim is the UPDATE's WHERE clause, not the read above it. A second press
 * finds nothing still `pending` and queues nothing, so a double press is
 * harmless without any lock.
 */
export async function enqueueBatch({
  businessId,
  now = new Date(),
}: {
  businessId: string;
  now?: Date;
}): Promise<{ queued: number; eligible: number }> {
  const eligible = await eligibleAppointmentIds(businessId, now);
  const remaining = await quotaRemaining(businessId);

  const take = Math.min(eligible.length, remaining, MAX_BATCH_SIZE);
  if (take === 0) return { queued: 0, eligible: eligible.length };

  const rows = await db
    .update(schema.appointments)
    .set({ status: "queued" })
    .where(
      and(
        eq(schema.appointments.businessId, businessId),
        eq(schema.appointments.status, "pending"),
        inArray(schema.appointments.id, eligible.slice(0, take)),
      ),
    )
    .returning({ id: schema.appointments.id });

  return { queued: rows.length, eligible: eligible.length };
}

/**
 * Empties the queue.
 *
 * Calls already in flight are left alone — you can stop a queue, not un-ring a
 * phone. Also the recovery for a queue that cannot drain itself, which is what
 * a requeued retry becomes while `phone_calls_enabled` is off.
 */
export async function stopBatch(businessId: string): Promise<number> {
  const rows = await db
    .update(schema.appointments)
    .set({ status: "pending" })
    .where(
      and(
        eq(schema.appointments.businessId, businessId),
        eq(schema.appointments.status, "queued"),
      ),
    )
    .returning({ id: schema.appointments.id });

  return rows.length;
}

/**
 * Puts an Appointment back in the queue for one more Call.
 *
 * Runs after `releaseAppointment` has returned the row to `pending`, which is
 * why `pending` is the status it keys on. The two conditions are the ones that
 * matter: a Tool that committed mid-Call has already written `confirmed` or
 * `rescheduled` and wins (SPEC.md §9 step 3), and an Appointment carrying a
 * reason is blocked from calling until a human clears it (issue #15).
 *
 * The retry is a **second Call row** — `reserveCall` numbers it attempt 2 when
 * the pump reaches it — not a revival of the first.
 */
export async function requeueForRetry(appointmentId: string): Promise<void> {
  await db
    .update(schema.appointments)
    .set({ status: "queued" })
    .where(
      and(
        eq(schema.appointments.id, appointmentId),
        eq(schema.appointments.status, "pending"),
        isNull(schema.appointments.needsAttentionReason),
      ),
    );
}

/**
 * Stops calling this Appointment and asks a human to look at it.
 *
 * **The Slot stays held.** `unreachable` is not in `SLOT_FREEING_STATUSES` and
 * `starts_at` is not touched, so the booking stays exactly where it is —
 * SPEC.md §14 rule 2: an unanswered phone is not a cancellation, and freeing a
 * Slot on that signal would destroy a real booking.
 *
 * `coalesce` because `book_failed` is the more specific reason and must
 * survive, which is the rule `flagTruncated` already follows. One statement
 * writing fixed values, so a redelivered webhook changes nothing.
 */
export async function markUnreachable(appointmentId: string): Promise<void> {
  await db
    .update(schema.appointments)
    .set({
      status: "unreachable",
      needsAttentionReason: sql`coalesce(${schema.appointments.needsAttentionReason}, 'unreachable')`,
    })
    .where(
      and(
        eq(schema.appointments.id, appointmentId),
        eq(schema.appointments.status, "pending"),
      ),
    );
}

export type BatchProgress = {
  /** Phone Calls running right now. */
  calling: number;
  /** Appointments waiting for a free slot. */
  waiting: number;
};

/**
 * What the strip above the table shows.
 *
 * `calling` counts **Phone** Calls only, which is what stops the strip
 * duplicating the live-call bar: a browser conversation is already reported
 * there, and a second banner announcing the same Call is noise. The throttle in
 * `pump.ts` counts every type, because a live Web Call genuinely is one of the
 * account's concurrent Calls.
 *
 * There is deliberately no "done" count. Without a Batch entity there is no
 * honest way to compute one, and a made-up number on the demo stage is worse
 * than an absent one.
 */
export async function batchProgress(
  businessId: string,
  now: Date = new Date(),
): Promise<BatchProgress> {
  const [waiting] = await db
    .select({ n: count() })
    .from(schema.appointments)
    .where(
      and(
        eq(schema.appointments.businessId, businessId),
        eq(schema.appointments.status, "queued"),
      ),
    );

  return {
    calling: await countInFlightCalls(db, businessId, now, ["phone"]),
    waiting: waiting.n,
  };
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run lib/calls/batch/queue.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/calls/batch/queue.ts lib/calls/batch/queue.test.ts
git commit -m "Hold the queue in the Appointment rows, and never free a Slot doing it"
```

---

## Task 9: The dialler port, and the refusal behind it

**Files:**
- Create: `lib/calls/batch/placer.ts`
- Test: `lib/calls/batch/placer.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { refusingPlacer } from "@/lib/calls/batch/placer";
import { db, schema } from "@/lib/db";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

/*
  SPEC.md §3 rule 9: never place a Phone Call from an account without
  `phone_calls_enabled`. Open signup plus arbitrary outbound dialling is a
  robocalling tool.

  The guard is here, at the boundary, as well as in the pump that calls it —
  issue #19's first acceptance criterion says an unflagged account cannot place
  a Phone Call *by any route*, and this is the route.
*/

const CLERK_ID = "user_test_batch_placer";
const STARTS_AT = new Date("2026-09-14T04:30:00.000Z");

let seed: ToolTestSeed;

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({ clerkId: CLERK_ID, appointmentStartsAt: STARTS_AT });
});

afterEach(() => cleanupToolTest(CLERK_ID));

describe("refusingPlacer", () => {
  it("refuses an unflagged account", async () => {
    expect(
      await refusingPlacer({
        businessId: seed.businessId,
        appointmentId: seed.appointmentId,
        callId: seed.callId,
      }),
    ).toEqual({ ok: false, reason: "phone_calls_disabled" });
  });

  it("still refuses a flagged one, because nothing dials yet", async () => {
    await db
      .update(schema.businesses)
      .set({ phoneCallsEnabled: true })
      .where(eq(schema.businesses.id, seed.businessId));

    expect(
      await refusingPlacer({
        businessId: seed.businessId,
        appointmentId: seed.appointmentId,
        callId: seed.callId,
      }),
    ).toEqual({ ok: false, reason: "phone_calls_not_implemented" });
  });

  it("refuses a Business that does not exist", async () => {
    expect(
      await refusingPlacer({
        businessId: "00000000-0000-0000-0000-000000000000",
        appointmentId: seed.appointmentId,
        callId: seed.callId,
      }),
    ).toEqual({ ok: false, reason: "phone_calls_disabled" });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/calls/batch/placer.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/calls/batch/placer"`.

- [ ] **Step 3: Write the implementation**

```ts
import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/*
  The one thing issue #17 does not build: dialling.

  Call All needs three Calls at once, and only the Phone Call path has any
  concurrency — a Web Call needs a browser to join it within 30 seconds
  (`docs/verification.md` A3), and a browser has one microphone. So the engine
  is built against this port and issue #19 supplies the implementation, along
  with the KYC, the number purchase and the kill switch.

  Everything the batch does is proven against a fake placer, which is also what
  keeps SPEC.md §3 rule 11 — no automated test places a real Call.
*/

export type PlaceCallParams = {
  businessId: string;
  appointmentId: string;
  /** The `calls` row the pump already reserved, waiting for a Retell id. */
  callId: string;
};

export type PlaceCallResult = { ok: true } | { ok: false; reason: string };

export type CallPlacer = (params: PlaceCallParams) => Promise<PlaceCallResult>;

/**
 * Today's only implementation.
 *
 * The flag check is deliberately duplicated — `pumpBatch` refuses before it
 * claims anything, so nothing reaches here on an unflagged account. It is
 * repeated because SPEC.md §3 rule 9 and issue #19 say an unflagged account
 * cannot place a Phone Call *by any route*, and a guard at the boundary is
 * worth more than a guard on the caller.
 *
 * `reason` lands in `calls.disconnect_reason`, so it is a short machine string
 * rather than a sentence — the same convention `create_web_call_failed` follows
 * in lib/calls/start-web-call.ts.
 */
export const refusingPlacer: CallPlacer = async ({ businessId }) => {
  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.id, businessId),
    columns: { phoneCallsEnabled: true },
  });

  if (!business?.phoneCallsEnabled) {
    return { ok: false, reason: "phone_calls_disabled" };
  }

  return { ok: false, reason: "phone_calls_not_implemented" };
};
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run lib/calls/batch/placer.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/calls/batch/placer.ts lib/calls/batch/placer.test.ts
git commit -m "Leave one hole for #19, with the flag guard already in it"
```

---

## Task 10: The pump, and the race it has to survive

**Files:**
- Create: `lib/calls/batch/pump.ts`
- Test: `lib/calls/batch/pump.test.ts`

This is the task the whole design exists for. The last test is the one that
fails against any implementation that counts and then places.

- [ ] **Step 1: Write the failing test**

```ts
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CallPlacer } from "@/lib/calls/batch/placer";
import { pumpBatch } from "@/lib/calls/batch/pump";
import { enqueueBatch } from "@/lib/calls/batch/queue";
import { db, schema } from "@/lib/db";
import type { AppointmentStatus } from "@/lib/db/schema";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

/*
  The throttle (issue #17's first acceptance criterion).

  The test this file exists for is the last one. Every other test here passes
  against a pump that counts what is in flight and then places the difference;
  only the concurrent one fails, because two callers both read "two in flight"
  and both place one. Same lesson as SPEC.md §3 rule 8, and the same shape as
  lib/calls/quota.test.ts.

  Nothing here contacts Retell (SPEC.md §3 rule 11): every placer is a fake.
*/

const CLERK_ID = "user_test_batch_pump";
const NOW = new Date("2026-09-01T00:00:00.000Z");
const FIRST_AT = new Date("2026-09-14T04:30:00.000Z");

let seed: ToolTestSeed;

/** A placer that succeeds and records what it was asked to dial. */
function fakePlacer(): CallPlacer & { calls: string[] } {
  const calls: string[] = [];
  const placer = (async ({ appointmentId }) => {
    calls.push(appointmentId);
    return { ok: true as const };
  }) as CallPlacer & { calls: string[] };
  placer.calls = calls;
  return placer;
}

async function addAppointment(dayOffset: number) {
  const startsAt = new Date(FIRST_AT.getTime() + dayOffset * 86_400_000);
  const [row] = await db
    .insert(schema.appointments)
    .values({
      businessId: seed.businessId,
      serviceId: seed.serviceId,
      name: `Person ${dayOffset}`,
      phoneE164: "+919876543211",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
      status: "pending",
    })
    .returning();
  return row;
}

async function callsPlaced() {
  return db
    .select({ id: schema.calls.id, status: schema.calls.status })
    .from(schema.calls)
    .innerJoin(
      schema.appointments,
      eq(schema.calls.appointmentId, schema.appointments.id),
    )
    .where(eq(schema.appointments.businessId, seed.businessId));
}

async function countByStatus(status: AppointmentStatus) {
  const rows = await db
    .select({ id: schema.appointments.id })
    .from(schema.appointments)
    .where(
      and(
        eq(schema.appointments.businessId, seed.businessId),
        eq(schema.appointments.status, status),
      ),
    );
  return rows.length;
}

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({ clerkId: CLERK_ID, appointmentStartsAt: FIRST_AT });
  // The seed leaves a Call and a `calling` Appointment behind. Clear both, so
  // each case starts with an empty account, and turn the phone flag on — every
  // test here is about the throttle, not about the flag.
  await db.delete(schema.calls).where(eq(schema.calls.id, seed.callId));
  await db
    .update(schema.appointments)
    .set({ status: "pending" })
    .where(eq(schema.appointments.id, seed.appointmentId));
  await db
    .update(schema.businesses)
    .set({ phoneCallsEnabled: true, callQuota: 50 })
    .where(eq(schema.businesses.id, seed.businessId));
});

afterEach(() => cleanupToolTest(CLERK_ID));

describe("pumpBatch", () => {
  it("places nothing when the queue is empty", async () => {
    const place = fakePlacer();

    expect(await pumpBatch({ businessId: seed.businessId, now: NOW, place })).toEqual({
      placed: 0,
    });
  });

  it("places three and leaves the rest waiting", async () => {
    for (let i = 1; i <= 5; i++) await addAppointment(i);
    await enqueueBatch({ businessId: seed.businessId, now: NOW });

    const place = fakePlacer();
    expect(await pumpBatch({ businessId: seed.businessId, now: NOW, place })).toEqual({
      placed: 3,
    });

    expect(place.calls).toHaveLength(3);
    expect(await countByStatus("calling")).toBe(3);
    expect(await countByStatus("queued")).toBe(3);
  });

  it("calls the soonest Appointment first", async () => {
    const later = await addAppointment(9);
    const sooner = await addAppointment(1);
    await db
      .update(schema.appointments)
      .set({ status: "queued" })
      .where(eq(schema.appointments.id, seed.appointmentId));
    await enqueueBatch({ businessId: seed.businessId, now: NOW });

    const place = fakePlacer();
    await pumpBatch({ businessId: seed.businessId, now: NOW, place });

    expect(place.calls[0]).toBe(seed.appointmentId);
    expect(place.calls[1]).toBe(sooner.id);
    expect(place.calls[2]).toBe(later.id);
  });

  it("tops up only the free slots", async () => {
    for (let i = 1; i <= 5; i++) await addAppointment(i);
    await enqueueBatch({ businessId: seed.businessId, now: NOW });

    const place = fakePlacer();
    await pumpBatch({ businessId: seed.businessId, now: NOW, place });
    // Two of the three finish; the third is still on the phone.
    const [first, second] = await callsPlaced();
    await db
      .update(schema.calls)
      .set({ status: "completed" })
      .where(eq(schema.calls.id, first.id));
    await db
      .update(schema.calls)
      .set({ status: "no_answer" })
      .where(eq(schema.calls.id, second.id));

    expect(await pumpBatch({ businessId: seed.businessId, now: NOW, place })).toEqual({
      placed: 2,
    });
  });

  it("refuses an account that cannot place Phone Calls, without spending", async () => {
    await db
      .update(schema.businesses)
      .set({ phoneCallsEnabled: false })
      .where(eq(schema.businesses.id, seed.businessId));
    await enqueueBatch({ businessId: seed.businessId, now: NOW });

    const place = fakePlacer();
    expect(await pumpBatch({ businessId: seed.businessId, now: NOW, place })).toEqual({
      placed: 0,
      blocked: "phone_calls_disabled",
    });

    // Nothing dialled, no Call row, no Quota, and the Appointment still waiting.
    expect(place.calls).toHaveLength(0);
    expect(await callsPlaced()).toHaveLength(0);
    expect(await countByStatus("queued")).toBe(1);
  });

  it("drains the queue when the Quota runs out mid-batch", async () => {
    for (let i = 1; i <= 4; i++) await addAppointment(i);
    await db
      .update(schema.businesses)
      .set({ callsUsed: 0, callQuota: 50 })
      .where(eq(schema.businesses.id, seed.businessId));
    await enqueueBatch({ businessId: seed.businessId, now: NOW });
    // Somebody else spent the account's Calls between the press and the pump.
    await db
      .update(schema.businesses)
      .set({ callsUsed: 50 })
      .where(eq(schema.businesses.id, seed.businessId));

    const place = fakePlacer();
    expect(await pumpBatch({ businessId: seed.businessId, now: NOW, place })).toEqual({
      placed: 0,
      blocked: "exhausted",
    });

    // Nothing is left claiming it is about to be called.
    expect(await countByStatus("queued")).toBe(0);
    expect(await countByStatus("calling")).toBe(0);
    expect(await countByStatus("pending")).toBe(5);
  });

  it("hands the Call back when the dial fails", async () => {
    await enqueueBatch({ businessId: seed.businessId, now: NOW });

    const refuse: CallPlacer = async () => ({ ok: false, reason: "no_number" });
    expect(await pumpBatch({ businessId: seed.businessId, now: NOW, place: refuse })).toEqual({
      placed: 0,
    });

    const [call] = await callsPlaced();
    const row = await db.query.calls.findFirst({
      where: eq(schema.calls.id, call.id),
    });
    expect(row?.status).toBe("failed");
    expect(row?.disconnectReason).toBe("no_number");

    // The Quota is given back — this failure is ours and provable on the server,
    // which is what separates it from a browser claiming its Call did not
    // connect (lib/calls/quota.ts).
    const business = await db.query.businesses.findFirst({
      where: eq(schema.businesses.id, seed.businessId),
    });
    expect(business?.callsUsed).toBe(0);

    // And it is NOT requeued: a permanently broken dialler would loop forever.
    expect(await countByStatus("pending")).toBe(1);
  });
});

describe("the throttle under concurrency", () => {
  it("lets exactly three of ten simultaneous pumps place a Call", async () => {
    for (let i = 1; i <= 9; i++) await addAppointment(i);
    await enqueueBatch({ businessId: seed.businessId, now: NOW });

    const place = fakePlacer();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        pumpBatch({ businessId: seed.businessId, now: NOW, place }),
      ),
    );

    // Three Calls, whichever pump won the lock.
    expect(results.reduce((total, result) => total + result.placed, 0)).toBe(3);
    expect(place.calls).toHaveLength(3);
    expect(await callsPlaced()).toHaveLength(3);
    expect(await countByStatus("calling")).toBe(3);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/calls/batch/pump.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/calls/batch/pump"`.

- [ ] **Step 3: Write the implementation**

```ts
import { and, asc, eq, sql } from "drizzle-orm";

import { countInFlightCalls } from "@/lib/calls/batch/in-flight";
import { MAX_CONCURRENT_CALLS } from "@/lib/calls/batch/limits";
import { refusingPlacer, type CallPlacer } from "@/lib/calls/batch/placer";
import { releaseCallQuota } from "@/lib/calls/quota";
import { releaseAppointment } from "@/lib/calls/record";
import { reserveCall } from "@/lib/calls/reserve";
import { db, schema } from "@/lib/db";

/*
  Filling the free slots in the throttle (issue #17).

  Called from three places: the Call all button, every `call_ended` webhook, and
  the 5-second tick on an open Overview page. All three do the same thing, which
  is why there is one function.

  **The obvious implementation is wrong.** Counting what is in flight and then
  placing the difference lets two webhooks arriving in the same millisecond both
  read "two running" and both place one — four Calls. That is SPEC.md §3 rule 8
  again: three concurrent Agents will find any gap between a check and a write.

  So the claim runs inside a per-Business advisory lock — a named Postgres lock,
  taken by number, that makes this Business's pumps take turns while every other
  account runs untouched. Two rules about what goes inside it:

  1. **No network call.** Dialling happens after the transaction commits. That is
     the same rule lib/calls/start-web-call.ts states about holding a lock across
     an HTTP round trip.
  2. **No reads through `db`.** The pool holds five connections; a read through
     `db` from inside a transaction takes a second one, and enough of those
     deadlock the app (lib/db/index.ts). Everything below passes `tx`.
*/

export type PumpResult = {
  placed: number;
  /** Why nothing more was placed, when something stopped it. */
  blocked?: "phone_calls_disabled" | "exhausted";
};

/** An Appointment claimed for a Call, with the row already reserved for it. */
type Claim = { appointmentId: string; callId: string };

export async function pumpBatch({
  businessId,
  now = new Date(),
  place = refusingPlacer,
}: {
  businessId: string;
  now?: Date;
  place?: CallPlacer;
}): Promise<PumpResult> {
  let blocked: PumpResult["blocked"];

  const claims = await db.transaction(async (tx): Promise<Claim[]> => {
    /*
      `hashtext` turns the Business id into the integer the lock is named by.
      Two Businesses could collide on the same number, which costs them nothing
      but taking turns with each other. `pg_advisory_xact_lock` releases when
      this transaction ends, however it ends — there is no unlock to forget.
    */
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${businessId}::text))`,
    );

    /*
      Before anything is claimed. SPEC.md §3 rule 9: an unflagged account may
      not place a Phone Call. Checking here is what stops a retry requeued by
      the webhook from reserving a row and spending a Call on a dial that is
      going to be refused anyway.
    */
    const business = await tx.query.businesses.findFirst({
      where: eq(schema.businesses.id, businessId),
      columns: { phoneCallsEnabled: true },
    });
    if (!business?.phoneCallsEnabled) {
      blocked = "phone_calls_disabled";
      return [];
    }

    const slots = MAX_CONCURRENT_CALLS - (await countInFlightCalls(tx, businessId, now));
    if (slots <= 0) return [];

    const waiting = await tx
      .select({ id: schema.appointments.id })
      .from(schema.appointments)
      .where(
        and(
          eq(schema.appointments.businessId, businessId),
          eq(schema.appointments.status, "queued"),
        ),
      )
      // Soonest first: the Appointment closest to happening is the one where a
      // rebooking is still worth something.
      .orderBy(asc(schema.appointments.startsAt))
      .limit(slots);

    const claimed: Claim[] = [];

    for (const { id } of waiting) {
      // The claim is this WHERE clause. No row means another pump took it.
      const [taken] = await tx
        .update(schema.appointments)
        .set({ status: "calling" })
        .where(
          and(
            eq(schema.appointments.id, id),
            eq(schema.appointments.status, "queued"),
          ),
        )
        .returning({ id: schema.appointments.id });
      if (!taken) continue;

      const reserved = await reserveCall(tx, {
        businessId,
        appointmentId: id,
        callType: "phone",
      });

      if (!reserved.ok) {
        /*
          The Quota ran out. Put this one back, and drain the rest of the queue
          with it — none of them can be placed either, and an Appointment left
          at `queued` that can never be called is a row lying about what is
          going to happen.
        */
        await tx
          .update(schema.appointments)
          .set({ status: "pending" })
          .where(eq(schema.appointments.id, id));
        await tx
          .update(schema.appointments)
          .set({ status: "pending" })
          .where(
            and(
              eq(schema.appointments.businessId, businessId),
              eq(schema.appointments.status, "queued"),
            ),
          );
        blocked = "exhausted";
        break;
      }

      claimed.push({ appointmentId: id, callId: reserved.callId });
    }

    return claimed;
  });

  /*
    Outside the lock, and one at a time rather than in parallel: there are at
    most three of these, and a sequential loop keeps the failure handling below
    readable.
  */
  let placed = 0;
  for (const claim of claims) {
    const result = await place({ businessId, ...claim });
    if (result.ok) {
      placed += 1;
      continue;
    }
    await handOverBack(businessId, claim, result.reason);
  }

  return blocked ? { placed, blocked } : { placed };
}

/**
 * Undoes a claim whose dial never happened.
 *
 * The Quota is refunded because this failure is ours and provable on the
 * server, which is the only kind lib/calls/quota.ts allows a refund for.
 *
 * The Appointment goes back to `pending`, **not** to `queued`. A dialler that
 * is permanently broken would otherwise take the same Appointment on every
 * pump, forever.
 */
async function handOverBack(
  businessId: string,
  { appointmentId, callId }: Claim,
  reason: string,
): Promise<void> {
  await db
    .update(schema.calls)
    .set({ status: "failed", endedAt: new Date(), disconnectReason: reason })
    .where(eq(schema.calls.id, callId));

  await releaseCallQuota(db, businessId);
  await releaseAppointment(appointmentId);
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run lib/calls/batch/pump.test.ts`
Expected: PASS, 8 tests. The concurrency case is the one to watch: if it reports
four or five Calls, the advisory lock is not doing its job — check that the
`sql` template really ran and that nothing inside the transaction reads through
`db` instead of `tx`.

- [ ] **Step 5: Commit**

```bash
git add lib/calls/batch/pump.ts lib/calls/batch/pump.test.ts
git commit -m "Make three concurrent Calls mean three, under any number of pumps"
```

---

## Task 11: The webhook decides what happens next

**Files:**
- Modify: `lib/webhooks/process.ts:102-127`
- Test: `lib/webhooks/process.test.ts` (add a describe block)

- [ ] **Step 1: Write the failing tests**

Add to `lib/webhooks/process.test.ts`. The file's `ended()` helper, `seed`,
`call()`, `appointment()`, `setCallStatus()` and `setAppointmentStatus()`
helpers already exist — read them before writing this.

```ts
/*
  What a silence leaves behind (issue #17).

  SPEC.md §14 rule 2 is the rule under test: an unanswered phone is not a
  cancellation. One retry, then a human — and the Slot never moves.
*/
describe("a Call nobody answered", () => {
  async function setAttempt(attempt: number) {
    await db
      .update(schema.calls)
      .set({ attempt })
      .where(eq(schema.calls.id, seed.callId));
  }

  it("puts the Appointment back in the queue after the first", async () => {
    await setAttempt(1);
    await setAppointmentStatus("calling");

    await processWebhookEvent(ended("dial_no_answer"));

    expect((await appointment())?.status).toBe("queued");
    expect((await call())?.status).toBe("no_answer");
  });

  it("gives up after the second, and asks for a human", async () => {
    await setAttempt(2);
    await setAppointmentStatus("calling");

    await processWebhookEvent(ended("dial_no_answer"));

    const row = await appointment();
    expect(row?.status).toBe("unreachable");
    expect(row?.needsAttentionReason).toBe("unreachable");
  });

  it("keeps the Slot when it gives up", async () => {
    await setAttempt(2);
    await setAppointmentStatus("calling");

    await processWebhookEvent(ended("dial_no_answer"));

    expect((await appointment())?.startsAt.getTime()).toBe(
      APPOINTMENT_STARTS_AT.getTime(),
    );
  });

  it("treats voicemail as a silence, because a machine is not the person", async () => {
    await setAttempt(1);
    await setAppointmentStatus("calling");

    await processWebhookEvent(ended("voicemail_reached"));

    expect((await appointment())?.status).toBe("queued");
  });

  it("leaves a Call that simply failed alone", async () => {
    // `error_user_not_joined` maps to `failed`, not `no_answer`
    // (docs/verification.md A9). Nobody declined to pick up a phone.
    await setAttempt(1);
    await setAppointmentStatus("calling");

    await processWebhookEvent(ended("error_user_not_joined"));

    expect((await appointment())?.status).toBe("pending");
  });

  it("does not undo an outcome a Tool committed", async () => {
    await setAttempt(1);
    await setAppointmentStatus("confirmed");

    await processWebhookEvent(ended("dial_no_answer"));

    expect((await appointment())?.status).toBe("confirmed");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run lib/webhooks/process.test.ts`
Expected: FAIL — the first case reports `pending`, because nothing requeues yet.

- [ ] **Step 3: Rewrite `applyEnded`**

In `lib/webhooks/process.ts`, add the imports:

```ts
import { pumpBatch } from "@/lib/calls/batch/pump";
import { markUnreachable, requeueForRetry } from "@/lib/calls/batch/queue";
import { afterCall } from "@/lib/calls/batch/retry";
```

and replace `applyEnded` with:

```ts
/**
 * The Call is over, and this is the delivery that says how it went.
 *
 * `transcript` and `recording_url` are written only when this delivery carries
 * them, so a `call_ended` that arrives without a transcript cannot blank one
 * that is already there.
 *
 * Then the aftermath (issue #17): a silence earns one retry, a second silence
 * earns a human. Both writes are conditional UPDATEs of fixed values, so a
 * redelivered `call_ended` changes nothing the second time.
 */
async function applyEnded(callId: string, event: WebhookEvent) {
  const status = mapDisconnectionReason(event.disconnectionReason);

  const [row] = await db
    .update(schema.calls)
    .set({
      status,
      disconnectReason: event.disconnectionReason,
      endedAt: event.endedAt ?? new Date(),
      ...(event.startedAt ? { startedAt: event.startedAt } : {}),
      ...(event.durationSeconds !== null
        ? { durationSeconds: event.durationSeconds }
        : {}),
      ...(event.transcript ? { transcript: event.transcript } : {}),
      ...(event.recordingUrl ? { recordingUrl: event.recordingUrl } : {}),
    })
    .where(eq(schema.calls.id, callId))
    .returning({
      appointmentId: schema.calls.appointmentId,
      attempt: schema.calls.attempt,
    });

  if (!row) return;

  // Returns the Appointment to `pending` if nothing decided its outcome, which
  // is the status the two writes below key on.
  await releaseAppointment(row.appointmentId);

  switch (afterCall({ status, attempt: row.attempt })) {
    case "retry":
      await requeueForRetry(row.appointmentId);
      break;
    case "unreachable":
      await markUnreachable(row.appointmentId);
      break;
  }

  await pumpAfter(row.appointmentId);
}

/**
 * Fills the slot this Call just freed.
 *
 * The whole batch runs on this: there is no background worker, because Cloud
 * Run withdraws CPU once a response is sent, so every Call after the first
 * three is placed by the delivery that ended an earlier one (ADR-0013).
 *
 * Wrapped, for the same reason Extraction is: a pump that throws must not undo
 * the Call row this handler has already written.
 */
async function pumpAfter(appointmentId: string): Promise<void> {
  try {
    const appointment = await db.query.appointments.findFirst({
      where: eq(schema.appointments.id, appointmentId),
      columns: { businessId: true },
    });
    if (!appointment) return;

    await pumpBatch({ businessId: appointment.businessId });
  } catch (error) {
    console.error(`[batch] pump after ${appointmentId} failed:`, error);
  }
}
```

- [ ] **Step 4: Run the webhook suite**

Run: `npx vitest run lib/webhooks/process.test.ts app/api/webhooks/retell/route.test.ts`
Expected: PASS, including the cases that were already there. The existing
"maps a disconnection reason" cases must stay green — `applyEnded` now computes
`status` once and reuses it rather than calling `mapDisconnectionReason` inline,
which is the only change to that behaviour.

- [ ] **Step 5: Commit**

```bash
git add lib/webhooks/process.ts lib/webhooks/process.test.ts
git commit -m "Let the webhook try once more, then stop and ask a human"
```

---

## Task 12: The four Server Actions

**Files:**
- Create: `app/(app)/calls/batch-actions.ts`

No test. These are thin wrappers — authenticate, delegate, revalidate — and
everything they delegate to is already covered. That is the same argument
`app/(app)/calls/actions.ts` makes for itself.

- [ ] **Step 1: Write the file**

```ts
"use server";

import { revalidatePath } from "next/cache";

import { requireBusiness } from "@/lib/business/require-business";
import { eligibleAppointmentIds, quotaRemaining } from "@/lib/calls/batch/eligible";
import { pumpBatch } from "@/lib/calls/batch/pump";
import {
  batchProgress,
  enqueueBatch,
  stopBatch,
  type BatchProgress,
} from "@/lib/calls/batch/queue";

/*
  Call All's Server Actions (issue #17).

  The three rules app/(app)/settings/actions.ts documents hold here too.
  `requireBusiness()` comes first in every one, because a Server Action is a
  POST anyone can send and rendering a button on an authenticated screen is not
  a security boundary. Nothing closes over anything. A refusal comes back as a
  value rather than a throw, because SPEC.md §11.4 wants inline persistent UI
  for anything requiring action.

  Every one is a thin wrapper on purpose: the writes live in lib/calls/batch/
  where they are tested without Clerk.
*/

export type { BatchProgress };

export type BatchPreview = {
  eligible: number;
  /** `null` means unlimited — an admin account. */
  quotaRemaining: number | null;
  phoneCallsEnabled: boolean;
};

/** What the confirmation sheet needs before it can say anything true. */
export async function batchPreviewAction(): Promise<BatchPreview> {
  const { business } = await requireBusiness();

  const [eligible, remaining] = await Promise.all([
    eligibleAppointmentIds(business.id),
    quotaRemaining(business.id),
  ]);

  return {
    eligible: eligible.length,
    // Infinity does not survive JSON, and `null` is what the summary expects.
    quotaRemaining: Number.isFinite(remaining) ? remaining : null,
    phoneCallsEnabled: business.phoneCallsEnabled,
  };
}

export type StartBatchState = {
  queued: number;
  progress: BatchProgress;
  message?: string;
};

/**
 * Queue everybody, and place the first three.
 *
 * The flag is checked here as well as inside the pump. Refusing before
 * `enqueueBatch` runs is what stops an unflagged account filling its table with
 * Queued rows that nothing will ever dial (SPEC.md §3 rule 9).
 */
export async function startBatchAction(): Promise<StartBatchState> {
  const { business } = await requireBusiness();

  if (!business.phoneCallsEnabled) {
    return {
      queued: 0,
      progress: await batchProgress(business.id),
      message: "Phone calls are off for this account.",
    };
  }

  const { queued } = await enqueueBatch({ businessId: business.id });
  await pumpBatch({ businessId: business.id });

  // The rows, the stat strip and the quota meter have all moved.
  revalidatePath("/");

  return { queued, progress: await batchProgress(business.id) };
}

/** Empty the queue. Calls already in flight are left to finish. */
export async function stopBatchAction(): Promise<BatchProgress> {
  const { business } = await requireBusiness();

  await stopBatch(business.id);
  revalidatePath("/");

  return batchProgress(business.id);
}

/**
 * One turn of the strip's 5-second tick.
 *
 * Two jobs. It fills any slot a finished Call left — belt and braces behind the
 * webhook, and the only thing that un-sticks a batch if a delivery never
 * arrives — and it returns the counts the strip renders.
 *
 * No `revalidatePath` here: the strip calls `router.refresh()` itself, and
 * doing both would refetch the page twice every five seconds.
 */
export async function tickBatchAction(): Promise<BatchProgress> {
  const { business } = await requireBusiness();

  await pumpBatch({ businessId: business.id });

  return batchProgress(business.id);
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add "app/(app)/calls/batch-actions.ts"
git commit -m "Give the screen four ways to talk to the queue"
```

---

## Task 13: The button and the strip

**Files:**
- Create: `components/overview/batch-strip-view.tsx`
- Create: `components/overview/batch-strip.tsx`
- Create: `components/overview/call-all-button.tsx`
- Test: `components/overview/batch-strip-view.test.tsx`
- Modify: `app/(app)/page.tsx:80-84`

The strip's markup is a separate, pure component so it can be rendered to a
string in a test — the same split `failure-card.tsx` and `retry-call-button.tsx`
use, and for the same reason: the client half reads hooks that need a browser.

- [ ] **Step 1: Write the failing test**

```tsx
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { BatchStripView } from "@/components/overview/batch-strip-view"

/*
  The persistent inline UI a running batch gets (SPEC.md §11.4 — inline, never
  a toast, for anything a person may need to act on).
*/

describe("BatchStripView", () => {
  it("renders nothing when no batch is running", () => {
    const html = renderToStaticMarkup(
      <BatchStripView calling={0} waiting={0} onStop={() => {}} stopping={false} />
    )

    expect(html).toBe("")
  })

  it("says what is happening and what is waiting", () => {
    const html = renderToStaticMarkup(
      <BatchStripView calling={2} waiting={4} onStop={() => {}} stopping={false} />
    )

    expect(html).toContain("Calling 2")
    expect(html).toContain("4 waiting")
    expect(html).toContain("Stop")
  })

  it("hides Stop once nothing is waiting, because it would do nothing", () => {
    const html = renderToStaticMarkup(
      <BatchStripView calling={1} waiting={0} onStop={() => {}} stopping={false} />
    )

    expect(html).toContain("Calling 1")
    expect(html).not.toContain("Stop")
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run components/overview/batch-strip-view.test.tsx`
Expected: FAIL — `Failed to resolve import "@/components/overview/batch-strip-view"`.

- [ ] **Step 3: Write the view**

`components/overview/batch-strip-view.tsx`:

```tsx
import { Loader2, PhoneOutgoing } from "lucide-react"

import { Button } from "@/components/ui/button"

/**
 * What a running batch looks like (issue #17), as pure markup.
 *
 * Split from the client component that polls so it can be rendered to a string
 * in a test — the same split `failure-card.tsx` uses.
 *
 * Renders nothing at zero, so it costs nothing on a quiet screen. Stop
 * disappears with the queue: it returns waiting Appointments to pending and
 * cannot un-ring a phone, so with nothing waiting it would do nothing, and a
 * control that does nothing is a lie.
 */
export function BatchStripView({
  calling,
  waiting,
  stopping,
  onStop,
}: {
  calling: number
  waiting: number
  stopping: boolean
  onStop: () => void
}) {
  if (calling === 0 && waiting === 0) return null

  return (
    <section
      aria-live="polite"
      className="flex items-center justify-between gap-4 rounded-card border border-line bg-surface px-4 py-3"
    >
      <div className="flex items-center gap-3 text-body text-text">
        {/* The accent is reserved for primary actions and live things
            (SPEC.md §11.2); a batch in flight is the second. */}
        <PhoneOutgoing className="size-4 text-accent" aria-hidden />
        <span className="font-mono">Calling {calling}</span>
        <span className="text-text-muted">·</span>
        <span className="font-mono text-text-muted">{waiting} waiting</span>
      </div>

      {waiting > 0 && (
        <Button variant="outline" size="sm" onClick={onStop} disabled={stopping}>
          {/* On the button itself; §11.4 rules out a full-page blocker. */}
          {stopping && <Loader2 className="animate-spin" aria-hidden />}
          {stopping ? "Stopping…" : "Stop"}
        </Button>
      )}
    </section>
  )
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run components/overview/batch-strip-view.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the client strip**

`components/overview/batch-strip.tsx`:

```tsx
"use client"

import { useRouter } from "next/navigation"
import * as React from "react"

import {
  stopBatchAction,
  tickBatchAction,
  type BatchProgress,
} from "@/app/(app)/calls/batch-actions"
import { BatchStripView } from "@/components/overview/batch-strip-view"

/**
 * The strip, and the tick that keeps it honest.
 *
 * Every 5 seconds while a batch is running (SPEC.md §11.3) it asks the server
 * for the counts. That call also pumps, which is what fills a slot if a webhook
 * never arrived — belt and braces behind ADR-0013's real mechanism.
 *
 * It also refreshes the page, which is what makes the Appointments table update
 * while Calls are in flight. The existing 5s refresh in
 * `components/calls/live-call-provider.tsx` cannot do that job: it only runs
 * while *this browser* owns a live Web Call, which is never true of a batch of
 * Phone Calls.
 *
 * The interval stops when nothing is running, so a quiet screen polls nothing.
 */
const TICK_MS = 5_000

export function BatchStrip({ initial }: { initial: BatchProgress }) {
  const [progress, setProgress] = React.useState(initial)
  const [stopping, startStopping] = React.useTransition()
  const router = useRouter()

  const running = progress.calling > 0 || progress.waiting > 0

  React.useEffect(() => {
    if (!running) return

    const interval = setInterval(async () => {
      setProgress(await tickBatchAction())
      router.refresh()
    }, TICK_MS)

    return () => clearInterval(interval)
  }, [running, router])

  /*
    The server's counts win over the ones this component is holding. A press of
    Call all, or a Call ending, both change them without this component doing
    anything, and `initial` arrives fresh with every re-render of the page.
  */
  React.useEffect(() => setProgress(initial), [initial])

  return (
    <BatchStripView
      calling={progress.calling}
      waiting={progress.waiting}
      stopping={stopping}
      onStop={() =>
        startStopping(async () => {
          setProgress(await stopBatchAction())
        })
      }
    />
  )
}
```

- [ ] **Step 6: Write the button**

`components/overview/call-all-button.tsx`:

```tsx
"use client"

import { Loader2, PhoneOutgoing } from "lucide-react"
import * as React from "react"

import {
  batchPreviewAction,
  startBatchAction,
  type BatchPreview,
} from "@/app/(app)/calls/batch-actions"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { batchSummary } from "@/lib/calls/batch/summary"

/**
 * Call all (SPEC.md §11.3), and the one confirmation in front of it.
 *
 * A row's "Call now" spends one Call and asks nothing. This spends every Call
 * the account has left, on real phones belonging to real people, so it states
 * the numbers first and waits.
 *
 * The preview is read when the sheet opens rather than with the page, because
 * it goes stale the moment another tab places a Call — reading it late is what
 * makes it true for as long as the sheet is open.
 *
 * `useTransition` and a direct call rather than `useActionState`, matching
 * `csv-upload.tsx`: there is no form here for an action to attach to.
 */
export function CallAllButton() {
  const [open, setOpen] = React.useState(false)
  const [preview, setPreview] = React.useState<BatchPreview | null>(null)
  const [starting, startCalling] = React.useTransition()

  async function show() {
    setOpen(true)
    setPreview(null)
    setPreview(await batchPreviewAction())
  }

  const summary = preview
    ? batchSummary({
        eligible: preview.eligible,
        quotaRemaining: preview.quotaRemaining,
        phoneCallsEnabled: preview.phoneCallsEnabled,
      })
    : null

  return (
    <>
      {/*
        Outline, not the accent default. §11.2 reserves the accent for primary
        actions, and the primary action on this screen is the Quick call card.
      */}
      <Button variant="outline" onClick={() => void show()}>
        <PhoneOutgoing aria-hidden />
        Call all
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="data-[side=right]:sm:max-w-lg"
          aria-describedby="call-all-description"
        >
          <SheetHeader>
            <SheetTitle>{summary?.title ?? "Call all"}</SheetTitle>
            <SheetDescription id="call-all-description">
              {summary?.detail ?? "Working out who can be called…"}
            </SheetDescription>
          </SheetHeader>

          <SheetFooter>
            <Button
              disabled={!summary?.canStart || starting}
              onClick={() =>
                startCalling(async () => {
                  await startBatchAction()
                  setOpen(false)
                })
              }
            >
              {starting && <Loader2 className="animate-spin" aria-hidden />}
              {starting
                ? "Starting…"
                : `Call ${summary?.willPlace ?? 0} now`}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  )
}
```

- [ ] **Step 7: Put both on the page**

In `app/(app)/page.tsx`, add the imports:

```tsx
import { BatchStrip } from "@/components/overview/batch-strip"
import { CallAllButton } from "@/components/overview/call-all-button"
import { batchProgress } from "@/lib/calls/batch/queue"
```

add the progress read to the existing `Promise.all`:

```tsx
  const [appointments, stats, services, callAlert, progress] = await Promise.all([
    listAppointments(business.id),
    appointmentStats(business.id),
    listServices(business.id),
    loadCallAlert(business.id),
    batchProgress(business.id),
  ])
```

then render the strip above the table and put the button in the toolbar beside
Upload CSV:

```tsx
        {/*
          Above the table, so a running batch is visible without scrolling. It
          renders nothing unless something is queued or a Phone Call is live.
        */}
        <BatchStrip initial={progress} />

        <AppointmentsTable
          appointments={appointments}
          timezone={business.timezone}
          toolbar={
            <div className="flex items-center gap-2">
              <UploadCsvButton timezone={business.timezone} />
              <CallAllButton />
            </div>
          }
        />
```

Update the file's header comment. The paragraph currently reads:

> Two of §11.3's items are deliberately absent, each with an owner: the Needs
> Attention section is #15, and Call all — with the ~5s revalidation while a
> Call is live — is #17 and #11.

Replace it with:

```
 * One of §11.3's items is still absent: the Needs Attention section is #15.
 * Call all arrived with #17, and brought the ~5s revalidation with it — the
 * strip's tick is what refreshes these rows while a batch of Phone Calls is in
 * flight, which `live-call-provider.tsx` cannot do because it only runs while
 * this browser owns a Web Call.
```

Also update the comment in `components/overview/appointments-table.tsx` that
says "Not here, deliberately: Call all (#17)" — it is here now, in `toolbar`.

**Not tested, and why.** The button itself gets no component test. Every
sentence it can show — including the disabled reason — is decided by
`batchSummary`, which Task 4 covers exhaustively; what is left is a `Sheet` and
a `useTransition`, and the repo does not test those (see the note at the end of
`docs/superpowers/specs/2026-08-21-call-detail-proof-screen-design.md`). The tick
gets no timer test for the same reason the Call detail poller does not.

- [ ] **Step 8: Typecheck, lint and run the whole suite**

Run: `npm run typecheck && npm run lint && npm test`
Expected: no errors, and every test passes.

- [ ] **Step 9: Commit**

```bash
git add components/overview/batch-strip-view.tsx components/overview/batch-strip-view.test.tsx components/overview/batch-strip.tsx components/overview/call-all-button.tsx "app/(app)/page.tsx"
git commit -m "Put Call all on the screen, with the numbers it is about to spend"
```

---

## Task 14: Prove the retry chain by replay

**Files:**
- Modify: `scripts/replay-webhook.ts`
- Modify: `fixtures/retell/webhooks/README.md`

SPEC.md §10 requires the replay suite to drive every state with no real Calls.
The `call-ended-no-answer.json` fixture already exists and is already driven —
what is new is that a no-answer now *does* something, and that behaviour has to
be proven over real HTTP through the real handler.

**This task needs `.env.local` and the Cloud SQL Auth Proxy running, plus
`next dev` in another terminal.** Nothing before it did.

- [ ] **Step 1: Move the no-answer ending out of the shared loop**

The existing `endings` loop delivers every ending to Calls hanging off **one**
shared Appointment. A no-answer now rewrites that Appointment — attempt 2 in
that loop would mark it `unreachable` — and the `book_slot` failure scenario
that runs afterwards needs it untouched.

So in `scripts/replay-webhook.ts`, delete the `no-answer` line from the
`endings` array in section 4, leaving:

```ts
    const endings = [
      ["call-ended-failed", "failed", "failed", "error_user_not_joined"],
      [
        "call-ended-credit-exhausted",
        "credit-exhausted",
        "failed",
        "no_valid_payment",
      ],
      [
        "call-ended-concurrency",
        "concurrency",
        "failed",
        "concurrency_limit_reached",
      ],
    ] as const;
```

All three of those map to `failed`, which earns nothing from `afterCall`, so the
shared Appointment is unaffected exactly as it is today. Leave `"no-answer"` in
the `scenarios` array — its Call row is reused below.

- [ ] **Step 2: Add the retry chain as its own section**

After section 5 (`proveBookFailure`), add:

```ts
    // ── 6. a silence, twice ──────────────────────────────────────────────
    heading("Nobody answers, twice");
    await proveUnreachable(business.id, service.id, service.durationMinutes);
```

and write the function beside `proveBookFailure`:

```ts
/**
 * The retry chain (issue #17): one silence requeues, the second gives up.
 *
 * On its own Appointment, at its own time, because it ends by marking that
 * Appointment `unreachable` — doing that to the Appointment every other
 * scenario shares would break them. Parked a day past the shared one so
 * `appointments_no_overlap` has nothing to refuse.
 *
 * The replay account has no phone flag, so the requeued Appointment is never
 * dialled and no Quota moves. That is the point: this proves the rule, not the
 * dialler, which is issue #19.
 */
async function proveUnreachable(
  businessId: string,
  serviceId: string,
  durationMinutes: number,
) {
  const startsAt = new Date(Date.now() + 366 * 86_400_000);

  const [appointment] = await db
    .insert(schema.appointments)
    .values({
      businessId,
      serviceId,
      // The same MARKER, so `cleanup` finds it by id and name.
      name: MARKER,
      phoneE164: "+919999999998",
      startsAt,
      endsAt: new Date(startsAt.getTime() + durationMinutes * 60_000),
      status: "calling",
    })
    .returning();

  try {
    for (const attempt of [1, 2] as const) {
      const retellCallId = `call_${MARKER}_retry_${attempt}`;
      const [call] = await db
        .insert(schema.calls)
        .values({
          appointmentId: appointment.id,
          retellCallId,
          callType: "phone",
          attempt,
          status: "queued",
        })
        .returning({ id: schema.calls.id });

      expect(
        `attempt ${attempt} ends dial_no_answer`,
        await deliver(
          "call-ended-no-answer",
          { id: call.id, retellCallId },
          appointment.id,
        ),
        200,
      );

      const wanted = attempt === 1 ? "queued" : "unreachable";
      const row = await waitFor(
        () =>
          db.query.appointments.findFirst({
            where: eq(schema.appointments.id, appointment.id),
          }),
        (found) => found?.status === wanted,
      );

      expect(`  the Appointment is ${wanted}`, row!.status, wanted);

      if (attempt === 2) {
        expect("  it needs attention", row!.needsAttentionReason, "unreachable");
        /*
          SPEC.md §14 rule 2, and the reason this whole scenario exists. An
          unanswered phone is not a cancellation: the Slot is still theirs.
        */
        expect(
          "  and it still holds its Slot",
          row!.startsAt.getTime(),
          startsAt.getTime(),
        );
      } else {
        // Back in the queue, waiting for a slot that will not come until #19.
        expect("  and it is waiting for one more try", row!.status, "queued");
      }
    }
  } finally {
    await cleanup(appointment.id);
  }
}
```

- [ ] **Step 3: Run the replay**

In one terminal: `npm run dev`. In another, with the Cloud SQL Auth Proxy
running:

Run: `APP_URL=http://localhost:3000 npm run replay-webhook`
(Match the port `next dev` actually chose — it is not 3000 when another worktree
already holds it.)

Expected: every line prints `ok`, including the two new ones under "Nobody
answers, twice", and the script ends with "Cleaned up."

If a run dies partway it leaves a `replay-…` Appointment behind and the next run
fails on `appointments_no_overlap`. Delete the leftover row and run again.

- [ ] **Step 4: Say what the fixture now proves**

In `fixtures/retell/webhooks/README.md`, change the `call-ended-no-answer` row of
"The files" table to:

```
| `call-ended-no-answer.json` | `dial_no_answer` — nobody picked up, no transcript. Driven **twice** by the replay, at attempt 1 and attempt 2 of one Appointment: the first requeues it, the second makes it unreachable (#17) |
```

and add a section after "Duplicate delivery":

```markdown
## The retry chain

A no-answer is not just a status. `lib/webhooks/process.ts` gives the first one
a retry and the second one a human — and the Appointment keeps its Slot either
way (SPEC.md §14 rule 2).

Proving that needs the same fixture delivered to two different Calls, because
the dedupe key is `(retell_call_id, event_type)` and a second delivery to the
same Call is by design a no-op. `scripts/replay-webhook.ts` builds its own
throwaway Appointment for this, so marking it unreachable disturbs nothing else
in the run.
```

- [ ] **Step 5: Commit**

```bash
git add scripts/replay-webhook.ts fixtures/retell/webhooks/README.md
git commit -m "Prove the retry and the held Slot over real HTTP, spending nothing"
```

---

## Task 15: Write down the two decisions that will look wrong later

**Files:**
- Create: `docs/adr/0013-call-all-throttled-in-app-pumped-by-webhooks.md`
- Comment on issue #21

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0013-call-all-throttled-in-app-pumped-by-webhooks.md`:

```markdown
# Call All is throttled in the app, and pumped by webhooks

Status: accepted

Issue #17 asks for one button that calls everybody, three Calls at a time. Two
facts decide how that is built, and neither is about the button.

**There is nowhere for a loop to run.** ADR-0001 records that Cloud Run
withdraws CPU when a response is sent. `--no-cpu-throttling` buys `after()` a
window at the end of one request (ADR-0012); it does not buy a process that
keeps placing Calls for the next ten minutes. There is no queue service in this
stack and adding one for a five-Call Quota would be absurd.

**The event that matters arrives later anyway.** "Nobody answered" is
`disconnection_reason` on `call_ended`, minutes after the Call was placed. So a
webhook handler is already involved in every retry, whatever else is true.

## Decision

The queue is `appointments.status = 'queued'`, and `call_ended` pumps it.

- **Queue.** Pressing Call all marks the callable Appointments `queued`, capped
  at the remaining Quota, and places the first three.
- **Pump.** `lib/webhooks/process.ts` tops the in-flight count back up to three
  after every ending, inside the `after()` block ADR-0012 established, and
  places any retry that ending earned.
- **Backstop.** An open Overview page ticks every five seconds. It pumps too,
  which un-sticks a batch if a delivery never arrives, and it is what refreshes
  the rows while a batch of Phone Calls is in flight — `live-call-provider.tsx`
  cannot, because it only runs while the browser owns a Web Call.
- **Throttle.** The claim runs inside `pg_advisory_xact_lock(hashtext(business))`
  with no network call held inside it. Counting in flight and then placing is
  not enough: two deliveries arriving together both read two running and both
  place one. Same lesson as SPEC.md §3 rule 8, applied to a limit instead of a
  range.

## Why three

**Cost control and demo pacing, not a platform limit.** A Retell
Pay-As-You-Go workspace is allowed twenty concurrent Calls and the first twenty
are free (`docs/verification.md` A10). Three is what keeps a demo watchable and
stops a five-Call Quota vanishing in one press.

This is worth stating plainly because the opposite reading is the natural one.
The README owes the sentence (SPEC.md §12's M7 deliverable, tracked on #21), and
`lib/calls/batch/limits.ts` carries it above the constant.

## Considered options

- **Retell's `POST /create-batch-call`.** Rejected, and `docs/verification.md`
  line 323 already said so: it gives no per-Call `call_id` mapping, which the
  data model in SPEC.md §5 is built on, and its `reserved_concurrency` is a
  manual hold rather than a throttle.
- **A `call_batches` table.** Rejected. Membership on the Appointment row needs
  no migration, no new noun in `CONTEXT.md`, and gives the table a Queued pill
  for free. What it gives up is a per-batch "done" count — which is why the
  strip shows "Calling 2 · 4 waiting" and no total.
- **Driving the whole batch from the browser.** Rejected. Closing the tab would
  halt a batch mid-way, and a retry earned by a no-answer would never be placed
  at all. The page tick survives as a backstop, not as the mechanism.
- **Placing Web Calls.** Rejected, and this is the decision that shapes the
  ticket. A Web Call needs a browser to join it within 30 seconds
  (`docs/verification.md` A3) and a browser has one microphone, so three at once
  is not possible. Three unjoined Web Calls would spend three of the account's
  five Calls on rows that all land `failed`. Call All therefore places Phone
  Calls, and #17 ships the engine behind a `CallPlacer` port while #19 supplies
  the dialler.

## Consequences

- **Call All does nothing on an unflagged account, on purpose.** The button
  says "Phone calls are off for this account" and queues nothing. Everything
  behind it is proven against the local Postgres with a fake placer and through
  the real webhook path by replay, spending nothing (SPEC.md §3 rule 11).
- **A retried Appointment waits at `queued` until #19 lands.** The pump refuses
  before it claims anything, so no Quota is spent and no Call row is written.
  This is the honest state — waiting to be called — and Stop clears it. The
  alternative, marking somebody unreachable after one silence because the
  account cannot dial, would contradict #17's own acceptance criteria and set a
  Needs Attention reason describing nothing that happened.
- **`queued` now means two things**, one on `appointments` and one on `calls`.
  They are analogous — both "written down, not yet dialled" — and both are
  documented at their declaration in `lib/db/schema.ts`.
- **A stalled Call cannot hold a slot forever.** In-flight is counted at read
  time with the same staleness rule as `lib/business/active-calls.ts`: a Call
  cannot outlive `max_call_duration_ms`, so a row older than that plus slack is
  a missing delivery rather than a Call. No cleanup job, nothing to schedule,
  nothing that can itself fail.
```

- [ ] **Step 2: Hand the README sentence to #21**

```bash
gh issue comment 21 --repo anushapundir/callzie --body "#17 owes the README one sentence it had nowhere to put: the three-concurrent-Call throttle on Call All is cost control and demo pacing, **not** a Retell limit — a Pay-As-You-Go workspace gets twenty concurrent Calls and the first twenty are free (docs/verification.md A10). The reasoning is recorded in ADR-0013 and above MAX_CONCURRENT_CALLS in lib/calls/batch/limits.ts; the README just needs to say it."
```

- [ ] **Step 3: Commit**

```bash
git add docs/adr/0013-call-all-throttled-in-app-pumped-by-webhooks.md
git commit -m "Record why the batch has no worker, and why three is three"
```

---

## Task 16: Final verification

- [ ] **Step 1: The whole suite, cold**

Run: `npm test`
Expected: every file passes. Watch `lib/calls/batch/pump.test.ts` in particular —
it is the one that depends on real contention.

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 3: Look at it**

Run `npm run dev` and open Overview.

- Call all sits beside Upload CSV. Pressing it opens a sheet saying "Phone calls
  are off for this account", and its button is disabled.
- No strip is visible, because nothing is queued.
- Place a Web Call from a row: the live-call bar appears and **no batch strip
  does**.

- [ ] **Step 4: Check the acceptance criteria off**

| Criterion | Proven by |
|---|---|
| Queues every pending Appointment, never exceeds three concurrent | `queue.test.ts` "queues every callable Appointment"; `pump.test.ts` "lets exactly three of ten simultaneous pumps place a Call" |
| Appointments needing attention are skipped | `eligible.test.ts` "skips an Appointment that needs attention" |
| A no-answer produces exactly one retry, tracked as a second attempt | `retry.test.ts`; `process.test.ts` "puts the Appointment back in the queue after the first"; `reserve.test.ts` numbers it attempt 2 |
| After the final attempt: unreachable, needs attention, Slot held | `queue.test.ts` "keeps the Slot, which is the whole point"; the replay's "Nobody answers, twice" |
| Quota respected across the whole batch | `queue.test.ts` "queues no more than the Quota allows"; `pump.test.ts` "drains the queue when the Quota runs out mid-batch" |
| Rows revalidate while Calls are in flight | `BatchStrip`'s 5s tick calling `tickBatchAction` and `router.refresh()` |

- [ ] **Step 5: Open the pull request**

```bash
git push -u origin anushapundir/call-all-throttling-and-retry-on-no-answer
gh pr create --fill
```

The PR body should lead with the thing a reviewer will otherwise ask about
first: **Call All cannot place a Call on any account today, on purpose.** The
engine, the throttle, the Quota rule and the retry rule are all here and all
proven; the dialler is #19's, and until it lands the button explains itself and
spends nothing.
