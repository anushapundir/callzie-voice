# The Needs Attention surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Overview surface where the four Needs Attention reasons land, block a flagged Appointment from being called, give a human one Clear action, and write the fourth reason — `unreachable` — for the first time.

**Architecture:** The block goes in exactly one server function, `startWebCall`, which is the only path that turns a request into a Call — so Call all (#17) and the Phone path (#19) inherit it. The `unreachable` decision is a pure predicate beside `wasNegotiationTruncated`, and its write is a conditional UPDATE beside `flagTruncated`. The panel is a Server Component with one client island for the Clear button.

**Tech Stack:** Next.js 16 App Router, TypeScript, Drizzle + Postgres, Tailwind + shadcn/ui, Vitest against a real local Postgres.

**Design:** `docs/superpowers/specs/2026-08-21-needs-attention-surface-design.md`
**Issue:** [#15](https://github.com/anushapundir/callzie/issues/15)

---

## Before you start

Read these three, in this order. They are short and they are the patterns every task below copies:

1. `lib/calls/truncation.ts` — the pure-predicate shape Task 1 follows exactly.
2. `lib/calls/record.ts:126-148` — `flagTruncated`, the conditional-UPDATE shape Task 2 follows exactly.
3. `components/overview/call-alerts.tsx` — the amber inline panel Task 7 follows exactly, including the `<section aria-labelledby>` decision and why it is not `role="alert"`.

**Two facts about this repo that will save you time:**

- Tests run against a **real Postgres started for you** by `vitest.globalSetup.ts`. There is no mocking layer for the database. `npm test` just works.
- **No test may place a real Call** (SPEC.md §3 rule 11). Retell is injected as a function type (`WebCallCreator`) and every test passes a fake.

**Commands:**

| What | Command |
|---|---|
| One test file | `npm test -- lib/calls/unreachable.test.ts` |
| One test by name | `npm test -- lib/calls/unreachable.test.ts -t "flags the second"` |
| Everything | `npm test` |
| Types | `npm run typecheck` |
| Lint | `npm run lint` |

---

## File structure

### Created

| File | Responsibility |
|---|---|
| `lib/calls/unreachable.ts` | `MAX_CALL_ATTEMPTS` and the pure `wasFinalNoAnswer` predicate. No database import |
| `lib/calls/unreachable.test.ts` | Every case of the predicate, without a database |
| `lib/appointments/attention-reason.ts` | Pure: a reason plus its context → one sentence |
| `lib/appointments/attention-reason.test.ts` | One test per reason |
| `lib/appointments/clear-attention.ts` | `clearNeedsAttention` — one column, scoped to the Business |
| `lib/appointments/clear-attention.test.ts` | Clears; touches nothing else; refuses another account |
| `lib/business/needs-attention.ts` | `listNeedsAttention` — the rows the panel renders |
| `lib/business/needs-attention.test.ts` | Filtering, ordering, the attempt count |
| `components/overview/needs-attention.tsx` | The panel. Server Component |
| `components/overview/needs-attention.test.tsx` | Hidden when empty; one row per Appointment |
| `components/overview/clear-attention-button.tsx` | The one client island |

### Modified

| File | Change |
|---|---|
| `lib/calls/record.ts` | Export `flagUnreachable`, beside the existing `flagTruncated` |
| `lib/calls/record.test.ts` | Cover `flagUnreachable`'s two guards |
| `lib/webhooks/process.ts` | `applyEnded` runs the rule after `releaseAppointment` |
| `lib/webhooks/process.test.ts` | The final no-answer flags; the first one does not |
| `lib/calls/start-web-call.ts` | A fifth refusal, before the Quota claim |
| `lib/calls/start-web-call.test.ts` | Refused, and the Quota is untouched |
| `lib/business/list-appointments.ts` | `AppointmentRow` carries `needsAttentionReason` |
| `lib/business/list-appointments.test.ts` | The new field is returned |
| `components/calls/call-now-button.tsx` | A `blocked` prop |
| `components/overview/appointments-table.tsx` | Pass `blocked` through |
| `app/(app)/actions.ts` | `clearAttentionAction` |
| `app/(app)/page.tsx` | Load and render the panel |
| `scripts/replay-webhook.ts` | Prove the new path end to end, then clear it |

**Why the writer lives in `record.ts` and not beside its predicate.** `lib/calls/truncation.ts` is pure and `flagTruncated` lives in `record.ts`; `lib/webhooks/process.ts` already imports `releaseAppointment` from there. Putting `flagUnreachable` anywhere else would be a second convention for the same thing. (The design doc describes the writer as sitting "beside" the predicate — beside in the sense of the same pair of files, which is what this is.)

---

## Task 1: The unreachable predicate

Pure, so every case is testable without a database, without Retell and without waiting for two phone calls to go unanswered.

**Files:**
- Create: `lib/calls/unreachable.ts`
- Test: `lib/calls/unreachable.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/calls/unreachable.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { MAX_CALL_ATTEMPTS, wasFinalNoAnswer } from "@/lib/calls/unreachable";

/*
  SPEC.md §5's fourth Needs Attention reason: "Final attempt with no answer.
  Slot stays held."

  "Final" needs a definition, and the repo did not have one — #17 owns retry and
  throttling and has not been built. Two attempts, as one constant, is the
  definition this ticket picks. Flagging on the first no-answer would foreclose
  #17 entirely: the block would fire before the retry it exists to make.

  Pure, so all of it is here rather than reachable only by having two real
  phone calls go unanswered.
*/

describe("wasFinalNoAnswer", () => {
  it("leaves the first no-answer callable", () => {
    // One missed Call is not an unreachable person. #17's retry has to be able
    // to happen, and a blocked Appointment cannot be called.
    expect(wasFinalNoAnswer({ callStatus: "no_answer", attempt: 1 })).toBe(
      false,
    );
  });

  it("flags the second no-answer", () => {
    expect(wasFinalNoAnswer({ callStatus: "no_answer", attempt: 2 })).toBe(true);
  });

  it("flags anything past the cap", () => {
    // #17 may raise MAX_CALL_ATTEMPTS. An attempt beyond it is still final —
    // `>=` rather than `===`, so a changed constant cannot skip the flag.
    expect(wasFinalNoAnswer({ callStatus: "no_answer", attempt: 7 })).toBe(true);
  });

  it("says nothing about a Call somebody answered", () => {
    // A conversation that happened has an outcome, or it has
    // `negotiation_truncated`. Either way it is not this reason.
    expect(wasFinalNoAnswer({ callStatus: "completed", attempt: 2 })).toBe(
      false,
    );
  });

  it("says nothing about a Call that broke", () => {
    /*
      `failed` covers an expired access token, an exhausted Retell balance and
      the concurrency limit (docs/verification.md A9). None of those is the
      person not picking up, and calling them unreachable would blame a customer
      for a billing problem.
    */
    expect(wasFinalNoAnswer({ callStatus: "failed", attempt: 2 })).toBe(false);
  });

  it("says nothing about a Call still in flight", () => {
    expect(wasFinalNoAnswer({ callStatus: "in_progress", attempt: 2 })).toBe(
      false,
    );
  });

  it("puts the cap at two", () => {
    // Pinned, because the number is the decision. Changing it should mean
    // changing this line on purpose.
    expect(MAX_CALL_ATTEMPTS).toBe(2);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -- lib/calls/unreachable.test.ts`

Expected: FAIL — `Failed to resolve import "@/lib/calls/unreachable"`.

- [ ] **Step 3: Write the implementation**

Create `lib/calls/unreachable.ts`:

```ts
import type { CallStatus } from "@/lib/db/schema";

/**
 * Whether a Call that nobody answered was the last one Callzie will make.
 *
 * SPEC.md §5's fourth Needs Attention reason. The Appointment keeps its Slot
 * and waits for a human — an unanswered phone is not a cancellation (SPEC.md
 * §14 rule 2), so nothing here frees anything.
 *
 * **Pure, and shaped for a second caller.** `lib/calls/truncation.ts` is the
 * same shape for the same reason: #17 owns retry and throttling, and when it
 * lands it changes this predicate rather than editing a webhook handler.
 */

/**
 * How many Calls an Appointment gets before nobody answering means unreachable.
 *
 * Two. The first no-answer leaves the Appointment callable, because one missed
 * Call is not an unreachable person and #17's retry has to be able to happen —
 * a blocked Appointment cannot be called at all.
 *
 * A judgement, not a measurement. Nobody has data on how often a second Callzie
 * Call reaches somebody the first missed. It is one constant so #17 can move it
 * once there is a reason to.
 */
export const MAX_CALL_ATTEMPTS = 2;

export type UnreachableInput = {
  /**
   * The Call's status *after* `mapDisconnectionReason`, not Retell's raw
   * reason.
   *
   * That mapping is where voicemail and IVR already land on `no_answer`
   * (`lib/webhooks/status.ts:39`) — a machine picking up is not the person
   * picking up, and SPEC.md §14 rule 2 turns on exactly that distinction.
   */
  callStatus: CallStatus;
  /** `calls.attempt` on the Call that just ended. 1 for the first. */
  attempt: number;
};

export function wasFinalNoAnswer({
  callStatus,
  attempt,
}: UnreachableInput): boolean {
  // Only nobody answering reaches this reason. A Call that connected has an
  // outcome or has `negotiation_truncated`; a Call that broke is a Callzie
  // problem, and blaming the customer for it would be wrong on the screen.
  if (callStatus !== "no_answer") return false;

  return attempt >= MAX_CALL_ATTEMPTS;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm test -- lib/calls/unreachable.test.ts`

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/calls/unreachable.ts lib/calls/unreachable.test.ts
git commit -m "Decide when nobody answering means unreachable"
```

---

## Task 2: Write the flag

`flagUnreachable` goes in `lib/calls/record.ts` directly beneath `flagTruncated`, and copies its shape: both guards inside the `WHERE` clause, never a read followed by an `if`.

**Files:**
- Modify: `lib/calls/record.ts`
- Test: `lib/calls/record.test.ts`

- [ ] **Step 1: Write the failing tests**

Open `lib/calls/record.test.ts`. Add `flagUnreachable` to the existing import from `@/lib/calls/record` — the file already imports `recordCallEnded` and friends from there. Then append this block at the end of the file:

```ts
describe("flagUnreachable", () => {
  it("writes both columns and holds the Slot", async () => {
    /*
      SPEC.md §5 makes the reason orthogonal to the status, and here both are
      true: the status is what the Appointment is, the reason is why Callzie
      stopped. The status alone would not block calling; the reason alone would
      leave the row's pill saying "Pending" about somebody nobody reached.
    */
    const before = await appointmentRow();

    await flagUnreachable(appointmentId);

    const row = await appointmentRow();
    expect(row.status).toBe("unreachable");
    expect(row.needsAttentionReason).toBe("unreachable");
    // SPEC.md §14 rule 2. An unanswered phone is not a cancellation.
    expect(row.startsAt).toEqual(before.startsAt);
    expect(row.endsAt).toEqual(before.endsAt);
  });

  it("leaves a more specific reason alone", async () => {
    /*
      `book_slot` may have written `book_failed` on an earlier Call. That is the
      more specific reason — a Call that tried and failed to book is not the same
      as one nobody picked up — and the first reason written wins, exactly as
      `flagTruncated` decides it.
    */
    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: "book_failed" })
      .where(eq(schema.appointments.id, appointmentId));

    await flagUnreachable(appointmentId);

    const row = await appointmentRow();
    expect(row.needsAttentionReason).toBe("book_failed");
    // And the status did not move either — the write is one statement.
    expect(row.status).not.toBe("unreachable");
  });

  it("never overwrites an outcome a Tool committed", async () => {
    // A no-answer Call has nobody in it who could have confirmed anything, so
    // this should be unreachable in practice. The guard costs one clause and
    // removes the whole class of bug.
    await db
      .update(schema.appointments)
      .set({ status: "confirmed" })
      .where(eq(schema.appointments.id, appointmentId));

    await flagUnreachable(appointmentId);

    const row = await appointmentRow();
    expect(row.status).toBe("confirmed");
    expect(row.needsAttentionReason).toBeNull();
  });

  it("is safe to apply twice", async () => {
    // Retell redelivers. The second application must be a no-op, not a second
    // write that finds a different row state.
    await flagUnreachable(appointmentId);
    await flagUnreachable(appointmentId);

    const row = await appointmentRow();
    expect(row.status).toBe("unreachable");
    expect(row.needsAttentionReason).toBe("unreachable");
  });

  it("leaves the database itself refusing to take the Slot", async () => {
    /*
      SPEC.md §14 rule 2, proved where it actually lives. Asserting that
      `starts_at` did not change only shows this function did not move it;
      this shows that nothing else can take the range either, because
      `unreachable` is absent from SLOT_FREEING_STATUSES (lib/db/schema.ts:69)
      and so stays inside the `appointments_no_overlap` EXCLUDE constraint.

      `lib/db/schema.test.ts:50` pins the constant against the migration SQL.
      This pins the behaviour the pair of them is supposed to produce.
    */
    await flagUnreachable(appointmentId);
    const held = await appointmentRow();

    await expect(
      db.insert(schema.appointments).values({
        businessId,
        serviceId: held.serviceId,
        name: "Daniel Okafor",
        phoneE164: "+12025550143",
        startsAt: held.startsAt,
        endsAt: held.endsAt,
        status: "pending",
      }),
    ).rejects.toThrow();
  });
});
```

**You need one helper.** `lib/calls/record.test.ts` already has a `needsAttention()` helper reading only the reason (line 166) and a module-level `appointmentId` (line 21). Add this beside the existing helper:

```ts
/** The whole Appointment row — these tests assert on the Slot as well. */
async function appointmentRow() {
  const row = await db.query.appointments.findFirst({
    where: eq(schema.appointments.id, appointmentId),
  });
  if (!row) throw new Error("the seeded Appointment vanished");
  return row;
}
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test -- lib/calls/record.test.ts -t "flagUnreachable"`

Expected: FAIL — `flagUnreachable is not exported by lib/calls/record.ts`.

- [ ] **Step 3: Write the implementation**

In `lib/calls/record.ts`, add `inArray` to the existing `drizzle-orm` import so the first line reads:

```ts
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
```

Then insert this function immediately after `flagTruncated` (after line 148, before the `ownedBy` helper):

```ts
/**
 * Nobody answered, and there will be no further attempt.
 *
 * SPEC.md §5's fourth reason. Both columns are written together because both
 * are true: `status` is what the Appointment is, `needs_attention_reason` is
 * why Callzie stopped. They are orthogonal (SPEC.md §5), not alternatives —
 * the status alone would not block calling, and the reason alone would leave
 * the row's Status pill saying "Pending" about somebody nobody reached.
 *
 * **The Slot is not freed, and not by this code deciding not to.** `unreachable`
 * is absent from `SLOT_FREEING_STATUSES` (lib/db/schema.ts:69), so the
 * `appointments_no_overlap` exclusion constraint goes on holding the range on
 * its own. SPEC.md §14 rule 2 is structural here rather than a rule somebody has
 * to remember.
 *
 * Two guards, both inside the WHERE clause for the reason SPEC.md §3 rule 8
 * gives — two workers handling a redelivered event cannot both win a check they
 * each made before writing.
 *
 * The reason guard means a more specific reason already there survives:
 * `book_failed` is a Call that tried and failed to book, which is not the same
 * thing as one nobody picked up. The status guard means a Tool-written
 * `confirmed` is never overwritten. That combination should be unreachable — a
 * no-answer Call has nobody in it to commit anything — and the clause costs
 * nothing.
 */
export async function flagUnreachable(appointmentId: string): Promise<void> {
  await db
    .update(schema.appointments)
    .set({ status: "unreachable", needsAttentionReason: "unreachable" })
    .where(
      and(
        eq(schema.appointments.id, appointmentId),
        isNull(schema.appointments.needsAttentionReason),
        inArray(schema.appointments.status, ["calling", "pending"]),
      ),
    );
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm test -- lib/calls/record.test.ts`

Expected: PASS — the five new tests plus every test that was already there.

- [ ] **Step 5: Commit**

```bash
git add lib/calls/record.ts lib/calls/record.test.ts
git commit -m "Flag an Appointment nobody answered, without freeing its Slot"
```

---

## Task 3: Run the rule from the webhook

`applyEnded` is the only place that knows a Call ended and why. The browser path is deliberately untouched: `recordCallFailed` writes `failed`, never `no_answer`, because the browser reports that a Call ended and not why.

**Files:**
- Modify: `lib/webhooks/process.ts:109-127`
- Test: `lib/webhooks/process.test.ts`

- [ ] **Step 1: Write the failing tests**

In `lib/webhooks/process.test.ts`, add this helper beside the existing `setCallStatus` / `setAppointmentStatus` helpers:

```ts
/** Which attempt the seeded Call is. `seedToolTest` writes 1. */
async function setCallAttempt(attempt: number) {
  await db
    .update(schema.calls)
    .set({ attempt })
    .where(eq(schema.calls.id, seed.callId));
}
```

Then add this block inside the existing `describe("call_ended", ...)`:

```ts
  describe("the final no-answer", () => {
    it("leaves the first attempt callable", async () => {
      // #17's retry has to be able to happen. Flagging here would block it.
      await processWebhookEvent(ended("dial_no_answer"));

      const row = await appointment();
      expect(row!.needsAttentionReason).toBeNull();
      expect(row!.status).toBe("pending");
    });

    it("flags the second attempt as unreachable", async () => {
      await setCallAttempt(2);

      await processWebhookEvent(ended("dial_no_answer"));

      const row = await appointment();
      expect(row!.status).toBe("unreachable");
      expect(row!.needsAttentionReason).toBe("unreachable");
    });

    it("does not move the Slot while flagging", async () => {
      /*
        Narrower than it sounds, deliberately. That an unreachable Appointment
        keeps its Slot is structural — `unreachable` is absent from
        SLOT_FREEING_STATUSES, so the exclusion constraint holds the range —
        and Task 2's `"leaves the database itself refusing to take the Slot"`
        proves the constraint actually fires. This only checks that flagging on
        this path does not move the times.
      */
      await setCallAttempt(2);

      await processWebhookEvent(ended("dial_no_answer"));

      expect((await appointment())!.startsAt).toEqual(APPOINTMENT_STARTS_AT);
    });

    it("leaves a reason an earlier Call already wrote", async () => {
      /*
        The guard proved end to end rather than only in
        lib/calls/record.test.ts. `book_slot` may have written `book_failed` on
        an earlier Call for this Appointment, and that is the more specific
        reason — a Call that tried and failed to book is not the same as one
        nobody picked up. Nothing on this path may quietly replace it.

        Without this, nothing at the webhook level distinguishes a guarded
        write from an unguarded one: `flagUnreachable` writes fixed values, so
        "is safe to redeliver" below passes either way.
      */
      await setCallAttempt(2);
      await db
        .update(schema.appointments)
        .set({ needsAttentionReason: "book_failed" })
        .where(eq(schema.appointments.id, seed.appointmentId));

      await processWebhookEvent(ended("dial_no_answer"));

      const row = await appointment();
      expect(row!.needsAttentionReason).toBe("book_failed");
      expect(row!.status).not.toBe("unreachable");
    });

    it("treats voicemail as nobody answering", async () => {
      /*
        docs/verification.md A9: Retell reports voicemail as `call_status:
        "ended"`, the same value a real conversation gets. `mapDisconnectionReason`
        already sorts it onto `no_answer` — a machine picking up is not the
        person picking up.
      */
      await setCallAttempt(2);

      await processWebhookEvent(ended("voicemail_reached"));

      expect((await appointment())!.needsAttentionReason).toBe("unreachable");
    });

    it("does not flag a Call that broke", async () => {
      /*
        Every reason that is not somebody failing to pick up maps to `failed`,
        and none of them reaches this reason. `no_valid_payment` is the one
        worth naming: an exhausted Retell balance is Callzie's problem, and
        marking the customer unreachable would blame them for a billing failure
        they know nothing about.
      */
      await setCallAttempt(2);

      await processWebhookEvent(ended("no_valid_payment"));

      const row = await appointment();
      expect(row!.needsAttentionReason).toBeNull();
      expect(row!.status).toBe("pending");
    });

    it("is safe to redeliver", async () => {
      await setCallAttempt(2);

      await processWebhookEvent(ended("dial_no_answer"));
      await processWebhookEvent(ended("dial_no_answer"));

      const row = await appointment();
      expect(row!.status).toBe("unreachable");
      expect(row!.needsAttentionReason).toBe("unreachable");
    });
  });
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test -- lib/webhooks/process.test.ts -t "the final no-answer"`

Expected: FAIL on "flags the second attempt as unreachable" — received `pending` and `null`. The first test in the block passes already, which is correct: it asserts behaviour that must not change.

- [ ] **Step 3: Write the implementation**

In `lib/webhooks/process.ts`, add two imports. Change line 3 to import both writers:

```ts
import { flagUnreachable, releaseAppointment } from "@/lib/calls/record";
```

and add, beside the existing `mapDisconnectionReason` import:

```ts
import { wasFinalNoAnswer } from "@/lib/calls/unreachable";
```

Then replace the whole of `applyEnded` (lines 102-127) with:

```ts
/**
 * The Call is over, and this is the delivery that says how it went.
 *
 * `transcript` and `recording_url` are written only when this delivery carries
 * them, so a `call_ended` that arrives without a transcript cannot blank one
 * that is already there.
 *
 * It also writes SPEC.md §5's fourth Needs Attention reason. That decision is
 * made here rather than in the browser path on purpose: `recordCallFailed`
 * writes `failed` and never `no_answer`, because the browser knows that a Call
 * ended and not why. Only Retell's own `disconnection_reason` can tell nobody
 * picking up apart from an expired access token.
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
      // Read back rather than counted here. `calls.attempt` is written once,
      // inside the transaction that claims the Quota
      // (lib/calls/start-web-call.ts), so it is the number the rule has to judge.
      attempt: schema.calls.attempt,
    });

  if (!row) return;

  await releaseAppointment(row.appointmentId);

  /*
    Order does not matter here, and it is worth saying so rather than leaving
    the next reader to work it out. `flagUnreachable` accepts `calling` or
    `pending`, so it would match this row either side of the release; run the
    other way round it would write `unreachable` and `releaseAppointment` —
    which only touches `calling` — would then no-op. Both sequences end on the
    same row.

    Release first anyway, because it is the step every ending takes and this
    one is the exception.
  */
  if (wasFinalNoAnswer({ callStatus: status, attempt: row.attempt })) {
    await flagUnreachable(row.appointmentId);
  }
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm test -- lib/webhooks/process.test.ts`

Expected: PASS — the seven new tests plus everything that was there.

- [ ] **Step 5: Commit**

```bash
git add lib/webhooks/process.ts lib/webhooks/process.test.ts
git commit -m "Let the webhook write the fourth Needs Attention reason"
```

---

## Task 4: Refuse to call a flagged Appointment

The load-bearing task. `startWebCall` is the only function that turns a request into a Call, so this is the only place the rule has to exist — Call all (#17) and the Phone path (#19) both go through it.

**Files:**
- Modify: `lib/calls/start-web-call.ts`
- Test: `lib/calls/start-web-call.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `lib/calls/start-web-call.test.ts`:

```ts
describe("an Appointment that needs attention", () => {
  it("is refused, with a reason a person can act on", async () => {
    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: "book_failed" })
      .where(eq(schema.appointments.id, appointmentId));

    const result = await startWebCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("needs_attention");
    expect(result.message).toContain("Clear it");
  });

  it("costs nothing", async () => {
    /*
      The whole point of refusing before `claimCallQuota`. Pressing a button
      that was going to be refused anyway must not spend one of five Calls,
      and it must not leave a `calls` row behind for the table to count as an
      attempt.
    */
    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: "unreachable" })
      .where(eq(schema.appointments.id, appointmentId));

    await startWebCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
    });

    const business = await db.query.businesses.findFirst({
      where: eq(schema.businesses.id, businessId),
    });
    expect(business!.callsUsed).toBe(0);

    const calls = await db
      .select()
      .from(schema.calls)
      .where(eq(schema.calls.appointmentId, appointmentId));
    expect(calls).toHaveLength(0);
  });

  it("never contacts Retell", async () => {
    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: "collision" })
      .where(eq(schema.appointments.id, appointmentId));

    const creator = fakeCreator();
    await startWebCall({ businessId, appointmentId, createWebCall: creator });

    expect(creator.calls).toHaveLength(0);
  });

  it.each([
    "book_failed",
    "collision",
    "negotiation_truncated",
    "unreachable",
  ] as const)("refuses on %s", async (reason) => {
    // All four block. The reason says what happened; none of them is milder
    // than the others as far as calling somebody goes.
    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: reason })
      .where(eq(schema.appointments.id, appointmentId));

    const result = await startWebCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
    });

    expect(result.ok).toBe(false);
  });

  it("is callable again once the reason is cleared", async () => {
    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: "book_failed" })
      .where(eq(schema.appointments.id, appointmentId));
    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: null })
      .where(eq(schema.appointments.id, appointmentId));

    const result = await startWebCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
    });

    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test -- lib/calls/start-web-call.test.ts -t "needs attention"`

Expected: FAIL — the first test gets `ok: true`, because nothing refuses yet.

- [ ] **Step 3: Write the implementation**

Three edits to `lib/calls/start-web-call.ts`.

**a. Add the column to the existing select** (inside the `.select({ ... })` starting at line 89):

```ts
      appointmentName: schema.appointments.name,
      startsAt: schema.appointments.startsAt,
      needsAttentionReason: schema.appointments.needsAttentionReason,
      serviceName: schema.services.name,
```

**b. Add the refusal to the result union and the messages.** Change the `reason` union on line 55 to:

```ts
      reason:
        | "not_found"
        | "needs_attention"
        | "exhausted"
        | "invalid_variables"
        | "retell_failed";
```

and add to `MESSAGES`:

```ts
  needs_attention:
    "This appointment needs attention. Clear it before calling again.",
```

**c. Refuse, immediately after the `if (!row)` block** (after line 116):

```ts
  /*
    SPEC.md §5: a non-null reason means Callzie will not call this person again
    until a human clears it. Phoning somebody to confirm a time that is about to
    change is worse than not phoning at all.

    **This is the only place the rule exists.** `startWebCall` is the one
    function that turns a request into a Call, so Call all (#17) and the Phone
    path (#19) inherit it without knowing it is here. Four call sites would be
    four places for it to drift, and the drift stays invisible until somebody
    gets phoned who should not have been.

    Before `claimCallQuota`, like every other refusal above and below it: a
    press that was always going to be refused must not cost one of five Calls.
  */
  if (row.needsAttentionReason !== null) {
    return {
      ok: false,
      reason: "needs_attention",
      message: MESSAGES.needs_attention,
    };
  }
```

Place it **before** the dynamic-variable check. A flagged Appointment should be refused for being flagged, not for a missing business name it also happens to have.

- [ ] **Step 4: Run and watch it pass**

Run: `npm test -- lib/calls/start-web-call.test.ts`

Expected: PASS — the eight new cases plus everything that was there.

`app/(app)/calls/actions.ts` needs no change: `startWebCallAction` collapses every refusal to `{ ok: false, message }`, so the new one already reaches the live Call bar.

- [ ] **Step 5: Commit**

```bash
git add lib/calls/start-web-call.ts lib/calls/start-web-call.test.ts
git commit -m "Refuse to call an Appointment that needs attention"
```

---

## Task 5: Clearing

One column. Not the Slot, not the status, not the Call history — SPEC.md §14 rules 2 and 3 both say Callzie hands over rather than deciding, and a Clear action that tidied the row up would be Callzie deciding.

**Files:**
- Create: `lib/appointments/clear-attention.ts`
- Test: `lib/appointments/clear-attention.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/appointments/clear-attention.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearNeedsAttention } from "@/lib/appointments/clear-attention";
import { db, schema } from "@/lib/db";
import {
  cleanupToolTest,
  seedToolTest,
  type ToolTestSeed,
} from "@/lib/tools/testing";

/*
  SPEC.md §5: clearing is the only resolution. Callzie never resolves a Needs
  Attention itself, so this is the one write that takes an Appointment out of
  the state — and it changes exactly one column.
*/

const CLERK_ID = "user_test_clear_attention";
const OTHER_CLERK_ID = "user_test_clear_attention_other";
const STARTS_AT = new Date("2026-09-02T03:30:00.000Z");

let seed: ToolTestSeed;
let other: ToolTestSeed;

async function appointmentRow(id: string) {
  const row = await db.query.appointments.findFirst({
    where: eq(schema.appointments.id, id),
  });
  if (!row) throw new Error("the seeded Appointment vanished");
  return row;
}

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  await cleanupToolTest(OTHER_CLERK_ID);

  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: STARTS_AT,
  });
  other = await seedToolTest({
    clerkId: OTHER_CLERK_ID,
    appointmentStartsAt: STARTS_AT,
  });

  await db
    .update(schema.appointments)
    .set({ needsAttentionReason: "book_failed" })
    .where(eq(schema.appointments.id, seed.appointmentId));
  await db
    .update(schema.appointments)
    .set({ needsAttentionReason: "book_failed" })
    .where(eq(schema.appointments.id, other.appointmentId));
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
  await cleanupToolTest(OTHER_CLERK_ID);
});

describe("clearNeedsAttention", () => {
  it("returns the Appointment to callable", async () => {
    await clearNeedsAttention(seed.businessId, seed.appointmentId);

    expect((await appointmentRow(seed.appointmentId)).needsAttentionReason)
      .toBeNull();
  });

  it("changes nothing else about it", async () => {
    /*
      The acceptance criterion, literally: "Clearing restores it to callable
      without altering its Slot or status." A Clear that also tidied the row up
      would be Callzie resolving something, which SPEC.md §5 says it never does.
    */
    const before = await appointmentRow(seed.appointmentId);

    await clearNeedsAttention(seed.businessId, seed.appointmentId);

    const after = await appointmentRow(seed.appointmentId);
    expect(after).toEqual({ ...before, needsAttentionReason: null });
  });

  it("leaves an unreachable status standing", async () => {
    /*
      Deliberate. Clearing says "a human has looked at this", not "this person
      turned out to be reachable after all". The pill goes on saying Unreachable
      until a Call proves otherwise, and the row is callable so one can be made.
    */
    await db
      .update(schema.appointments)
      .set({ status: "unreachable", needsAttentionReason: "unreachable" })
      .where(eq(schema.appointments.id, seed.appointmentId));

    await clearNeedsAttention(seed.businessId, seed.appointmentId);

    const row = await appointmentRow(seed.appointmentId);
    expect(row.needsAttentionReason).toBeNull();
    expect(row.status).toBe("unreachable");
  });

  it("clears nothing for another Business", async () => {
    // The cross-tenant guard, and it is inside the WHERE clause rather than a
    // read followed by a check — same shape as `ownedBy` in lib/calls/record.ts.
    await clearNeedsAttention(seed.businessId, other.appointmentId);

    expect((await appointmentRow(other.appointmentId)).needsAttentionReason)
      .toBe("book_failed");
  });

  it("is a no-op on an Appointment that is already clear", async () => {
    await clearNeedsAttention(seed.businessId, seed.appointmentId);
    await clearNeedsAttention(seed.businessId, seed.appointmentId);

    expect((await appointmentRow(seed.appointmentId)).needsAttentionReason)
      .toBeNull();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test -- lib/appointments/clear-attention.test.ts`

Expected: FAIL — `Failed to resolve import "@/lib/appointments/clear-attention"`.

- [ ] **Step 3: Write the implementation**

Create `lib/appointments/clear-attention.ts`:

```ts
import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/**
 * A human has looked at this Appointment. Callzie may call it again.
 *
 * SPEC.md §5: clearing is the only resolution — Callzie never resolves a Needs
 * Attention itself. So this is the one write that takes an Appointment out of
 * the state, and it is triggered by a person pressing a button and by nothing
 * else.
 *
 * **One column.** Not the Slot, not the status, not the Call history. Clearing
 * says "somebody has seen this", not "this turned out to be fine" — an
 * Appointment cleared after an unreachable Call is callable again and still
 * honestly `unreachable` until a Call proves otherwise.
 *
 * Scoped to the Business inside the WHERE clause rather than by a read followed
 * by a check, the same shape as `ownedBy` in lib/calls/record.ts. An
 * Appointment id from another account matches nothing and writes nothing, so
 * there is no branch that could act on one.
 *
 * Silent on a row that was already clear. A Server Action is a POST anyone can
 * send twice, and a double-press is not an error worth a message.
 */
export async function clearNeedsAttention(
  businessId: string,
  appointmentId: string,
): Promise<void> {
  await db
    .update(schema.appointments)
    .set({ needsAttentionReason: null })
    .where(
      and(
        eq(schema.appointments.id, appointmentId),
        eq(schema.appointments.businessId, businessId),
      ),
    );
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm test -- lib/appointments/clear-attention.test.ts`

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/appointments/clear-attention.ts lib/appointments/clear-attention.test.ts
git commit -m "Let a human clear a Needs Attention, and change nothing else"
```

---

## Task 6: The sentences

Pure, so the copy is testable without React — the same split `lib/appointments/status-style.ts` already makes for the Status pill.

**Files:**
- Create: `lib/appointments/attention-reason.ts`
- Test: `lib/appointments/attention-reason.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/appointments/attention-reason.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { explainNeedsAttention } from "@/lib/appointments/attention-reason";
import { NEEDS_ATTENTION_REASONS } from "@/lib/db/schema";

/*
  Issue #15's first acceptance criterion asks for "a specific, human-readable
  explanation" per reason. Specific means two things here: what went wrong, and
  what is still true about the Slot. The second half is the one a person needs —
  the fear when a row appears in this list is that the appointment has been lost.
*/

const SLOT = "Fri 14 Aug, 09:00";

describe("explainNeedsAttention", () => {
  it("says a booking failed and the old time still stands", () => {
    expect(
      explainNeedsAttention({
        reason: "book_failed",
        slotLabel: SLOT,
        attempts: 1,
      }),
    ).toBe(
      `Maya could not book the new time. The original slot is still held — ${SLOT}.`,
    );
  });

  it("says a Collision is not Callzie's to resolve", () => {
    // SPEC.md §14 rule 3: it detects, blocks, and hands over.
    expect(
      explainNeedsAttention({
        reason: "collision",
        slotLabel: SLOT,
        attempts: 0,
      }),
    ).toBe(
      "This clashes with an event on the connected Google Calendar. " +
        "Callzie will not move either one — decide which keeps the time, " +
        "then clear this.",
    );
  });

  it("says the call ended before anything was agreed", () => {
    expect(
      explainNeedsAttention({
        reason: "negotiation_truncated",
        slotLabel: SLOT,
        attempts: 1,
      }),
    ).toBe(
      `The call ended before a new time was agreed. The slot is still held — ${SLOT}.`,
    );
  });

  it("counts the attempts nobody answered", () => {
    expect(
      explainNeedsAttention({
        reason: "unreachable",
        slotLabel: SLOT,
        attempts: 2,
      }),
    ).toBe(`Nobody answered after 2 attempts. The slot is still held — ${SLOT}.`);
  });

  it("says one attempt, not one attempts", () => {
    // A count with the wrong noun reads as a bug, the same call
    // components/overview/csv-rejections.tsx makes for rows.
    expect(
      explainNeedsAttention({
        reason: "unreachable",
        slotLabel: SLOT,
        attempts: 1,
      }),
    ).toContain("after 1 attempt.");
  });

  it("has a sentence for every reason the schema allows", () => {
    /*
      The guard that matters. `collision` has no writer until #20 and
      `NEEDS_ATTENTION_REASONS` is the only list of all four — if somebody adds a
      fifth, this fails here rather than rendering an empty row on the dashboard.
    */
    for (const reason of NEEDS_ATTENTION_REASONS) {
      const sentence = explainNeedsAttention({
        reason,
        slotLabel: SLOT,
        attempts: 1,
      });
      expect(sentence.length).toBeGreaterThan(0);
      expect(sentence).not.toContain("undefined");
    }
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test -- lib/appointments/attention-reason.test.ts`

Expected: FAIL — `Failed to resolve import "@/lib/appointments/attention-reason"`.

- [ ] **Step 3: Write the implementation**

Create `lib/appointments/attention-reason.ts`:

```ts
import type { NeedsAttentionReason } from "@/lib/db/schema";

/**
 * What to tell a person about an Appointment Callzie has stopped calling.
 *
 * Pure, and it takes the Slot already formatted rather than a `Date` and a
 * timezone. A time means nothing without the Business's zone, the Server
 * Component that renders this has the zone and calls `formatInZone` once, and
 * keeping `Intl` out of here is what makes every sentence testable as a string.
 * Same split `lib/appointments/status-style.ts` makes for the Status pill.
 *
 * Every sentence says two things: what went wrong, and what is still true about
 * the Slot. The second half is the one a person actually needs — the fear when
 * a row turns up in this list is that the appointment has been lost, and in
 * three of four cases nothing has been lost at all.
 *
 * `collision` is the exception and says nothing about the Slot, because both
 * times are still standing and that is the whole problem. SPEC.md §14 rule 3:
 * Callzie detects, blocks, and hands over.
 *
 * A `switch` with no `default`, on purpose. `NeedsAttentionReason` is a closed
 * union, so a fifth reason added to `lib/db/schema.ts` fails `npm run typecheck`
 * here instead of rendering an empty row on somebody's dashboard.
 */

export type AttentionContext = {
  reason: NeedsAttentionReason;
  /** The Appointment's Slot, already formatted in the Business's timezone. */
  slotLabel: string;
  /** How many Calls have been placed for this Appointment. */
  attempts: number;
};

export function explainNeedsAttention({
  reason,
  slotLabel,
  attempts,
}: AttentionContext): string {
  switch (reason) {
    case "book_failed":
      // SPEC.md §8 step 3: the Appointment keeps its original Slot. Maya has
      // already told the person somebody will call back to confirm.
      return `Maya could not book the new time. The original slot is still held — ${slotLabel}.`;

    case "collision":
      return (
        "This clashes with an event on the connected Google Calendar. " +
        "Callzie will not move either one — decide which keeps the time, " +
        "then clear this."
      );

    case "negotiation_truncated":
      // Worded around the outcome rather than the 120s cap, because
      // lib/calls/truncation.ts flags the wider case — a Call that named times
      // and committed nothing, whatever the clock said.
      return `The call ended before a new time was agreed. The slot is still held — ${slotLabel}.`;

    case "unreachable":
      return (
        `Nobody answered after ${attempts} ` +
        `${attempts === 1 ? "attempt" : "attempts"}. ` +
        `The slot is still held — ${slotLabel}.`
      );
  }
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm test -- lib/appointments/attention-reason.test.ts`

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/appointments/attention-reason.ts lib/appointments/attention-reason.test.ts
git commit -m "Say what went wrong, and what is still true about the Slot"
```

---

## Task 7: The rows to render

**Files:**
- Create: `lib/business/needs-attention.ts`
- Test: `lib/business/needs-attention.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/business/needs-attention.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listNeedsAttention } from "@/lib/business/needs-attention";
import { db, schema } from "@/lib/db";
import {
  cleanupToolTest,
  seedToolTest,
  type ToolTestSeed,
} from "@/lib/tools/testing";

/*
  The rows the Needs Attention panel renders (SPEC.md §11.3 item 3).

  Deliberately a second query rather than a filter over `listAppointments`: that
  one is capped at 20 rows and ordered for the table, and a flagged Appointment
  sitting at position 21 would silently vanish from the surface that exists to
  show it.
*/

const CLERK_ID = "user_test_needs_attention";
const NINE_AM = new Date("2026-09-02T03:30:00.000Z");
const ELEVEN_AM = new Date("2026-09-02T05:30:00.000Z");

let seed: ToolTestSeed;

/** A second Appointment for the same Business, at a later time. */
async function secondAppointment() {
  const [row] = await db
    .insert(schema.appointments)
    .values({
      businessId: seed.businessId,
      serviceId: seed.serviceId,
      name: "Daniel Okafor",
      phoneE164: "+12025550143",
      startsAt: ELEVEN_AM,
      endsAt: new Date(ELEVEN_AM.getTime() + 60 * 60_000),
      status: "pending",
    })
    .returning();
  return row.id;
}

async function flag(
  appointmentId: string,
  reason: "book_failed" | "collision" | "negotiation_truncated" | "unreachable",
) {
  await db
    .update(schema.appointments)
    .set({ needsAttentionReason: reason })
    .where(eq(schema.appointments.id, appointmentId));
}

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: NINE_AM,
  });
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
});

describe("listNeedsAttention", () => {
  it("returns nothing for a healthy Business", async () => {
    // The panel renders nothing at all in this case — it is not an empty state.
    expect(await listNeedsAttention(seed.businessId)).toEqual([]);
  });

  it("returns only the flagged Appointments", async () => {
    await secondAppointment();
    await flag(seed.appointmentId, "book_failed");

    const rows = await listNeedsAttention(seed.businessId);

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(seed.appointmentId);
    expect(rows[0].name).toBe("Priya Sharma");
    expect(rows[0].reason).toBe("book_failed");
    expect(rows[0].startsAt).toEqual(NINE_AM);
  });

  it("carries the Service name", async () => {
    await flag(seed.appointmentId, "collision");

    expect((await listNeedsAttention(seed.businessId))[0].serviceName).toBe(
      "Haircut",
    );
  });

  it("counts the Calls placed, for the unreachable sentence", async () => {
    await flag(seed.appointmentId, "unreachable");
    // `seedToolTest` already wrote one Call. A second makes two attempts.
    await db.insert(schema.calls).values({
      appointmentId: seed.appointmentId,
      callType: "web",
      attempt: 2,
      status: "no_answer",
    });

    expect((await listNeedsAttention(seed.businessId))[0].attempts).toBe(2);
  });

  it("counts zero for an Appointment flagged without a Call", async () => {
    // A Collision needs no Call at all — #20 detects it from the calendar.
    const id = await secondAppointment();
    await flag(id, "collision");

    const rows = await listNeedsAttention(seed.businessId);
    expect(rows.find((row) => row.id === id)!.attempts).toBe(0);
  });

  it("puts the soonest Appointment first", async () => {
    // The one about to happen is the one somebody has to deal with first.
    const later = await secondAppointment();
    await flag(later, "collision");
    await flag(seed.appointmentId, "book_failed");

    const rows = await listNeedsAttention(seed.businessId);

    expect(rows.map((row) => row.id)).toEqual([seed.appointmentId, later]);
  });

  it("returns nothing for another Business", async () => {
    await flag(seed.appointmentId, "book_failed");

    expect(
      await listNeedsAttention("00000000-0000-0000-0000-000000000000"),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test -- lib/business/needs-attention.test.ts`

Expected: FAIL — `Failed to resolve import "@/lib/business/needs-attention"`.

- [ ] **Step 3: Write the implementation**

Create `lib/business/needs-attention.ts`:

```ts
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type { NeedsAttentionReason } from "@/lib/db/schema";

/**
 * The Appointments a human has to deal with (SPEC.md §11.3 item 3).
 *
 * **A second query rather than a filter over `listAppointments`.** That one is
 * capped at 20 rows and ordered for the table; a flagged Appointment sitting at
 * position 21 would silently disappear from the surface that exists to show it.
 * There is no cap here on purpose — this list is bounded by how much has gone
 * wrong, and truncating it would hide exactly the thing it is for.
 *
 * An explicit `innerJoin` rather than the relational query API, because no
 * `relations()` are declared anywhere in this repo — `lib/db/schema.ts` wires
 * tables with FK `.references()` only. Same call `lib/business/list-appointments.ts`
 * documents.
 *
 * Ordered soonest first: the Appointment about to happen is the one somebody
 * has to deal with first.
 */

export type NeedsAttentionRow = {
  id: string;
  name: string;
  startsAt: Date;
  serviceName: string;
  reason: NeedsAttentionReason;
  /** How many Calls have been placed. The `unreachable` sentence counts them. */
  attempts: number;
};

export async function listNeedsAttention(
  businessId: string,
): Promise<NeedsAttentionRow[]> {
  const rows = await db
    .select({
      id: schema.appointments.id,
      name: schema.appointments.name,
      startsAt: schema.appointments.startsAt,
      serviceName: schema.services.name,
      reason: schema.appointments.needsAttentionReason,
      /*
        A correlated subquery rather than a join plus GROUP BY. The join would
        have to be a LEFT JOIN — a Collision is flagged with no Call behind it
        (#20 detects it from the calendar) — and grouping every column of the
        Appointment to count a child table is more SQL to read for a list bounded
        by a 5-Call Quota.
      */
      attempts: sql<number>`(
        SELECT count(*)::int FROM ${schema.calls}
         WHERE ${schema.calls.appointmentId} = ${schema.appointments.id}
      )`,
    })
    .from(schema.appointments)
    .innerJoin(
      schema.services,
      eq(schema.appointments.serviceId, schema.services.id),
    )
    .where(
      and(
        eq(schema.appointments.businessId, businessId),
        isNotNull(schema.appointments.needsAttentionReason),
      ),
    )
    // Covered by `appointments_business_id_starts_at_idx`.
    .orderBy(asc(schema.appointments.startsAt));

  /*
    `flatMap` rather than a cast. The WHERE clause already excludes nulls, but
    the column's type does not know that — and dropping a row whose reason
    somehow came back null is better than rendering a card with no sentence in
    it.
  */
  return rows.flatMap((row) =>
    row.reason === null ? [] : [{ ...row, reason: row.reason }],
  );
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm test -- lib/business/needs-attention.test.ts`

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/business/needs-attention.ts lib/business/needs-attention.test.ts
git commit -m "Read the Appointments a human has to deal with"
```

---

## Task 8: The panel

**Files:**
- Create: `components/overview/needs-attention.tsx`
- Create: `components/overview/clear-attention-button.tsx`
- Test: `components/overview/needs-attention.test.tsx`

Read `components/overview/call-alerts.tsx` first. This copies its `<section aria-labelledby>` decision, its amber tokens, and its reasoning.

- [ ] **Step 1: Write the failing test**

Create `components/overview/needs-attention.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { NeedsAttention } from "@/components/overview/needs-attention";
import type { NeedsAttentionRow } from "@/lib/business/needs-attention";

/*
  What the surface actually puts on the page.

  `renderToStaticMarkup` rather than a testing library, matching
  components/schedule/day-grid.test.tsx: `NeedsAttention` is a synchronous
  Server Component with no state and no effects, so a string of HTML is the whole
  output. The Clear button inside it is a client island and renders as a plain
  disabled-capable <button> here, which is all these assertions need.

  The Server Action module is stubbed because importing it pulls in Clerk, which
  wants a request context no test has.
*/
vi.mock("@/app/(app)/actions", () => ({
  clearAttentionAction: async () => {},
}));

const KOLKATA = "Asia/Kolkata";

const BOOK_FAILED: NeedsAttentionRow = {
  id: "appt-1",
  name: "Priya Sharma",
  startsAt: new Date("2026-08-14T03:30:00.000Z"),
  serviceName: "Cleaning",
  reason: "book_failed",
  attempts: 1,
};

const UNREACHABLE: NeedsAttentionRow = {
  id: "appt-2",
  name: "Daniel Okafor",
  startsAt: new Date("2026-08-14T06:00:00.000Z"),
  serviceName: "Haircut",
  reason: "unreachable",
  attempts: 2,
};

function render(rows: NeedsAttentionRow[]): string {
  return renderToStaticMarkup(
    <NeedsAttention rows={rows} timezone={KOLKATA} />,
  );
}

describe("NeedsAttention", () => {
  it("renders nothing at all when there is nothing wrong", () => {
    // SPEC.md §11.3: "only when non-empty". Not an empty state — no section.
    expect(render([])).toBe("");
  });

  it("counts what is in it", () => {
    expect(render([BOOK_FAILED, UNREACHABLE])).toContain(
      "2 appointments need attention",
    );
  });

  it("says one appointment, not one appointments", () => {
    expect(render([BOOK_FAILED])).toContain("1 appointment needs attention");
  });

  it("says why Callzie has stopped", () => {
    // The rule the whole surface exists to make visible (SPEC.md §5).
    expect(render([BOOK_FAILED])).toContain(
      "Callzie will not call these until you clear them",
    );
  });

  it("names the person and the specific problem", () => {
    const html = render([BOOK_FAILED]);

    expect(html).toContain("Priya Sharma");
    expect(html).toContain("Maya could not book the new time");
  });

  it("counts attempts in the unreachable row", () => {
    expect(render([UNREACHABLE])).toContain("Nobody answered after 2 attempts");
  });

  it("shows the Slot in the Business's timezone", () => {
    // 03:30 UTC is 09:00 in Kolkata. A time in the viewer's zone would be a
    // different appointment.
    expect(render([BOOK_FAILED])).toContain("09:00");
  });

  it("gives every row its own Clear action", () => {
    const html = render([BOOK_FAILED, UNREACHABLE]);

    expect(html.match(/>Clear</g)).toHaveLength(2);
  });

  it("names each Clear for a screen reader", () => {
    // Two identical buttons are two identical announcements without this — the
    // same call components/calls/call-now-button.tsx makes.
    const html = render([BOOK_FAILED, UNREACHABLE]);

    expect(html).toContain("— Priya Sharma");
    expect(html).toContain("— Daniel Okafor");
  });

  it("is a labelled section rather than a live region", () => {
    /*
      Persistent UI, so no `role="alert"`. A live region would have a screen
      reader re-announce the whole list on every unrelated re-render of the page,
      of which there is one after every quick-add. Same call
      components/overview/call-alerts.tsx makes.
    */
    const html = render([BOOK_FAILED]);

    expect(html).toContain('aria-labelledby="needs-attention-heading"');
    expect(html).not.toContain('role="alert"');
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test -- components/overview/needs-attention.test.tsx`

Expected: FAIL — `Failed to resolve import "@/components/overview/needs-attention"`.

- [ ] **Step 3: Write the Clear button**

Create `components/overview/clear-attention-button.tsx`:

```tsx
"use client"

import { Loader2 } from "lucide-react"
import * as React from "react"

import { clearAttentionAction } from "@/app/(app)/actions"
import { Button } from "@/components/ui/button"

/**
 * The only way out of Needs Attention (SPEC.md §5).
 *
 * The one client island in the panel. `useTransition` rather than
 * `useActionState`, matching `components/overview/csv-upload.tsx`: there is no
 * form and no returned state to render — the action revalidates and the row
 * simply stops existing.
 *
 * §11.4 wants every async action to carry a loading state on its own button
 * rather than blocking the page, which is what `clearing` is for. Working a
 * queue of three means pressing three buttons, and only the pressed one should
 * look busy.
 *
 * **No confirmation step.** It is one column, the Appointment stays in the table
 * below, and the Call it came from keeps its `tool_invocations`. A confirm
 * dialog on a queue somebody works through is friction with nothing behind it.
 *
 * `outline`, not the accent default. §11.2 reserves the accent for primary
 * actions, and the primary action on this screen is placing a Call.
 */
export function ClearAttentionButton({
  appointmentId,
  name,
}: {
  appointmentId: string
  name: string
}) {
  const [clearing, startClearing] = React.useTransition()

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={clearing}
      onClick={() =>
        startClearing(async () => {
          await clearAttentionAction(appointmentId)
        })
      }
    >
      {/* The spinner, because every other pending button in this repo has one
          — see quick-call-card.tsx and csv-upload.tsx. */}
      {clearing && <Loader2 className="animate-spin" aria-hidden />}
      {clearing ? "Clearing…" : "Clear"}
      {/* Three identical buttons are three identical announcements without
          this — the same call `call-now-button.tsx` makes. */}
      <span className="sr-only"> — {name}</span>
    </Button>
  )
}
```

- [ ] **Step 4: Write the panel**

Create `components/overview/needs-attention.tsx`:

```tsx
import { ClearAttentionButton } from "@/components/overview/clear-attention-button"
import { explainNeedsAttention } from "@/lib/appointments/attention-reason"
import type { NeedsAttentionRow } from "@/lib/business/needs-attention"
import { formatInZone } from "@/lib/time/zone"

/**
 * The surface four failure paths converge on (SPEC.md §11.3 item 3, §5).
 *
 * A Server Component holding no state: the rows arrive already read and already
 * filtered, and the only thing here that reacts is the Clear button on each row.
 *
 * **Inline and persistent, not a toast.** SPEC.md §11.4 reserves toasts for
 * transient results and asks for inline persistent UI for anything requiring
 * action. Every row here is an Appointment Callzie has stopped calling, which is
 * the definition — and a message that fades after four seconds would leave
 * somebody wondering why a "Call now" button no longer works.
 *
 * **No Dismiss, on purpose.** Clear is the only exit, and it is a write. A
 * dismiss control would let somebody hide a person who is still waiting for a
 * phone call.
 *
 * **Nothing here auto-resolves.** SPEC.md §5 and §14 rules 2 and 3. The panel
 * has no timer, no retry and no cleanup pass; it renders what the column says
 * until a human presses a button.
 *
 * **Amber, not red.** §11.2's `attention` colour means a human has to act, which
 * is exactly this. `components/overview/status-pill.tsx` reserves red for the
 * person on the phone saying no, and keeping that line drawn matters more than
 * the vague sense that a failure should be red.
 *
 * The times are formatted here rather than in the browser, so one `Intl` pass
 * happens on the server and no hydration mismatch is possible between the
 * viewer's clock and the Business's.
 */
export function NeedsAttention({
  rows,
  timezone,
}: {
  rows: NeedsAttentionRow[]
  timezone: string
}) {
  // "Only when non-empty" (SPEC.md §11.3). Not an empty state — no section at
  // all, so a healthy account's Overview does not carry a heading about
  // problems it does not have.
  if (rows.length === 0) return null

  return (
    <section
      aria-labelledby="needs-attention-heading"
      /*
        A section, not `role="alert"`. This is persistent, and a live region
        would have a screen reader re-announce the whole list on every unrelated
        re-render of the page — of which there is one after every quick-add.
      */
      className="flex flex-col gap-4 rounded-card border border-attention bg-surface p-4"
    >
      <div className="flex flex-col gap-1">
        <h2
          id="needs-attention-heading"
          className="text-section font-semibold text-attention"
        >
          {rows.length === 1
            ? "1 appointment needs attention"
            : `${rows.length} appointments need attention`}
        </h2>
        <p className="text-body text-text-muted">
          Callzie will not call these until you clear them.
        </p>
      </div>

      <ul className="flex flex-col gap-3">
        {rows.map((row) => {
          const slotLabel = formatInZone(row.startsAt, timezone)

          return (
            <li
              key={row.id}
              className="flex flex-col gap-1 border-t border-line pt-3 first:border-t-0 first:pt-0"
            >
              <div className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
                {/*
                  The `{" "}` are load-bearing, not formatting. JSX drops
                  whitespace between elements written on separate lines, and the
                  dots are `aria-hidden` — so without them the row reads
                  "Priya SharmaFri 14 Aug, 09:00Cleaning" to a screen reader,
                  and has no line-break opportunity for wrapping at 375px. The
                  dots' padding looks like a space without being one.
                */}
                <p className="text-table text-text">
                  {row.name}{" "}
                  <span aria-hidden className="px-1 text-text-muted">
                    ·
                  </span>{" "}
                  {/*
                    Mono, per §11.2 — Slot times belong with phone numbers and
                    durations. `whitespace-nowrap` because "Fri 14 Aug, 09:00"
                    has spaces of its own and is meant to read as one token: it
                    should move to the next line whole rather than splitting
                    after the comma.
                  */}
                  <span className="font-mono whitespace-nowrap text-text-muted">
                    {slotLabel}
                  </span>{" "}
                  <span aria-hidden className="px-1 text-text-muted">
                    ·
                  </span>{" "}
                  <span className="text-text-muted">{row.serviceName}</span>
                </p>

                <ClearAttentionButton
                  appointmentId={row.id}
                  name={row.name}
                />
              </div>

              <p className="text-table text-text-muted">
                {explainNeedsAttention({
                  reason: row.reason,
                  slotLabel,
                  attempts: row.attempts,
                })}
              </p>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
```

- [ ] **Step 5: Run and watch it pass**

Run: `npm test -- components/overview/needs-attention.test.tsx`

Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add components/overview/needs-attention.tsx components/overview/clear-attention-button.tsx components/overview/needs-attention.test.tsx
git commit -m "Build the surface four failure paths converge on"
```

---

## Task 9: Wire it into Overview

**Files:**
- Modify: `app/(app)/actions.ts`
- Modify: `app/(app)/page.tsx`

There is no test in this task. Both files are wiring — the action is the same three-line shape the other actions in the file already are, and the page is composition. What they call is covered by Tasks 5, 7 and 8. Step 3 is a manual check in a browser.

- [ ] **Step 1: Add the Server Action**

In `app/(app)/actions.ts`, add to the imports:

```ts
import { clearNeedsAttention } from "@/lib/appointments/clear-attention";
```

and append at the end of the file, before the `text` helper:

```ts
/**
 * A human has dealt with an Appointment Callzie stopped calling (issue #15).
 *
 * The same three-line shape as every other action in this file:
 * `requireBusiness()` first — a Server Action is a POST reachable by anyone who
 * can send it, and rendering a button on an authenticated screen is not a
 * security boundary — then delegate, then revalidate.
 *
 * The Business id comes from the session and is passed separately, so the only
 * thing the browser supplies is which Appointment. An id belonging to another
 * account matches nothing inside `clearNeedsAttention`'s WHERE clause.
 *
 * That one `revalidatePath` refreshes three things in the same round trip: the
 * panel loses the row, the stat strip's Needs attention count drops, and the
 * table's "Call now" button for that row stops being disabled. Nothing polls,
 * and there is no client cache to reconcile.
 *
 * Returns nothing. There is no failure a person could act on — an id that
 * resolves to nothing writes nothing — and the row disappearing is the result.
 *
 * That does mean a wrong id plumbed through here would fail silently. What
 * catches it is the revalidate below: the row stays in the panel, which is the
 * bug showing itself on the screen the person is already looking at. Worth
 * naming, because this is the only documented way out of Needs Attention and
 * "it just didn't work and said nothing" would otherwise be a long afternoon.
 */
export async function clearAttentionAction(
  appointmentId: string,
): Promise<void> {
  const { business } = await requireBusiness();

  await clearNeedsAttention(business.id, appointmentId);

  revalidatePath("/");
}
```

- [ ] **Step 2: Render the panel**

In `app/(app)/page.tsx`, add two imports:

```ts
import { NeedsAttention } from "@/components/overview/needs-attention"
import { listNeedsAttention } from "@/lib/business/needs-attention"
```

Add it to the parallel load — replace the `Promise.all` block:

```ts
  const [appointments, stats, services, callAlert, needsAttention] =
    await Promise.all([
      listAppointments(business.id),
      appointmentStats(business.id),
      listServices(business.id),
      loadCallAlert(business.id),
      listNeedsAttention(business.id),
    ])
```

Then render it between the Quick Call card and the table:

```tsx
        <QuickCallCard
          services={services}
          initialSlots={initialSlots}
          timezone={business.timezone}
        />

        {/*
          Directly above the table, following SPEC.md §11.3's own numbering —
          stat strip, Quick call card, Needs Attention, table. It renders
          nothing on a healthy account.

          The third amber surface on this screen, and the only one of the three
          that reads from the database. `CallAlert` is the newest Call's
          disconnection reason and `CsvRejections` is the last upload's report;
          neither is a `needs_attention_reason`. They share the colour because
          they share the meaning — a human has to act — not because they are the
          same thing.
        */}
        <NeedsAttention
          rows={needsAttention}
          timezone={business.timezone}
        />

        <AppointmentsTable
```

Also update the file's header comment. Replace:

```
 * Two of §11.3's items are deliberately absent, each with an owner: the Needs
 * Attention section is #15, and Call all — with the ~5s revalidation while a
 * Call is live — is #17 and #11.
```

with:

```
 * One of §11.3's items is still absent, with an owner: Call all — and the ~5s
 * revalidation while a Call is live — is #17 and #11.
```

And in `components/overview/call-alerts.tsx`, change "First of the two amber surfaces" — that line is in `app/(app)/page.tsx`, not the component. Update it to:

```
          First of the three amber surfaces, because it is the one that stops
          everything: while the Retell balance is empty, pressing "Call now"
          cannot work. It renders nothing unless the most recent Call hit it.
```

- [ ] **Step 3: Check it renders**

Run: `npm run dev`, sign in, and open `/`.

Expected: no Needs Attention section on a freshly seeded account. Then flag a row by hand:

```bash
npm run db:studio
```

Set `needs_attention_reason` to `book_failed` on one Appointment, reload `/`, and confirm: the amber panel appears above the table with that person's name, the count in the stat strip reads 1 in amber, and pressing Clear makes the panel vanish and the count drop — with no page reload of your own.

- [ ] **Step 4: Types and lint**

Run: `npm run typecheck && npm run lint`

Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add app/\(app\)/actions.ts app/\(app\)/page.tsx
git commit -m "Put the Needs Attention surface on Overview"
```

---

## Task 10: Stop the table offering a Call it cannot place

The server already refuses (Task 4). This makes the button say so before it is pressed, which is the difference between a refusal and a button that looks broken.

**Files:**
- Modify: `lib/business/list-appointments.ts`
- Modify: `lib/business/list-appointments.test.ts`
- Modify: `components/calls/call-now-button.tsx`
- Modify: `components/overview/appointments-table.tsx`
- Modify: `lib/settings/hours-conflicts.test.ts`

**Why that last one.** Adding a required field to `AppointmentRow` breaks every
literal of that type, and `hours-conflicts.test.ts:17` builds one — it is the
only other place in the repo that does. Typecheck fails until it says
`needsAttentionReason: null`. Nothing about that file's subject changes; it
tests whether an Appointment falls outside newly narrowed Business Hours, which
has nothing to do with calling.

Add it beside the fields already there, folding the existing `// No Calls...`
comment into one block:

```ts
    status: "confirmed",
    /*
      No Calls, and nothing needing attention. This file is about whether an
      Appointment falls outside newly narrowed Business Hours, which nothing to
      do with calling touches — these fields are here because `AppointmentRow`
      is the shape `appointmentsOutsideHours` takes, not because this test has
      an opinion about them.
    */
    attempts: 0,
    lastCallId: null,
    lastCallAt: null,
    isCalling: false,
    needsAttentionReason: null,
```

- [ ] **Step 1: Write the failing test**

In `lib/business/list-appointments.test.ts`, add:

The file's `beforeEach` seeds exactly one Appointment, held in a module-level `appointmentId` (line 17), and already declares `ELEVEN_AM` and `NOON` (lines 12-13). Add this test inside the existing `describe("listAppointments", ...)`:

```ts
  it("carries the Needs Attention reason, so the row can stop offering a Call", async () => {
    /*
      The table disables "Call now" from this. It is a fact about the row
      already on screen, unlike the Quota, which is an account-wide number
      another tab can spend — see the comment in
      components/calls/call-now-button.tsx.
    */
    const [healthy] = await db
      .insert(schema.appointments)
      .values({
        businessId,
        serviceId,
        name: "Daniel Okafor",
        phoneE164: "+12025550143",
        startsAt: ELEVEN_AM,
        endsAt: NOON,
      })
      .returning();

    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: "book_failed" })
      .where(eq(schema.appointments.id, appointmentId));

    const rows = await listAppointments(businessId);

    expect(rows.find((row) => row.id === appointmentId)!.needsAttentionReason)
      .toBe("book_failed");
    expect(rows.find((row) => row.id === healthy.id)!.needsAttentionReason)
      .toBeNull();
  });
```

- [ ] **Step 2: Run and watch it fail**

Run: `npm test -- lib/business/list-appointments.test.ts -t "Needs Attention reason"`

Expected: FAIL — `Property 'needsAttentionReason' does not exist on type 'AppointmentRow'`.

- [ ] **Step 3: Add the field**

In `lib/business/list-appointments.ts`, add the import:

```ts
import type { AppointmentStatus, NeedsAttentionReason } from "@/lib/db/schema";
```

Add to the `AppointmentRow` type, after `status`:

```ts
  /**
   * Non-null means Callzie will not call this person again until a human clears
   * it (SPEC.md §5). The table reads it to disable "Call now"; the refusal
   * itself lives on the server in `lib/calls/start-web-call.ts`.
   */
  needsAttentionReason: NeedsAttentionReason | null;
```

And add it to the select, after `status`:

```ts
      needsAttentionReason: schema.appointments.needsAttentionReason,
```

- [ ] **Step 4: Run and watch it pass**

Run: `npm test -- lib/business/list-appointments.test.ts`

Expected: PASS.

- [ ] **Step 5: Teach the button to say why**

Replace `components/calls/call-now-button.tsx` entirely:

```tsx
"use client"

import { Phone } from "lucide-react"

import { useLiveCall } from "@/components/calls/live-call-provider"
import { Button } from "@/components/ui/button"

/**
 * "Call now" on one Appointment's row (SPEC.md §11.3).
 *
 * Disabled for two different reasons, and the `title` says which — a disabled
 * control that does not explain itself reads as a broken one.
 *
 * `busy` is temporary: there is one bar and one Call, so the rest of the table
 * waits. `blocked` is not temporary at all — the Appointment needs attention,
 * and nothing but a human pressing Clear will change that. So `blocked` wins the
 * title when both are true.
 *
 * The Quota is still deliberately NOT checked here. A button that hid itself
 * when the meter ran out would be guessing at a bound the server owns, and the
 * two would disagree the moment another tab spent the last Call.
 * `needs_attention_reason` is different in kind: it is a fact carried on the row
 * already rendered, so disabling on it is reporting rather than guessing.
 *
 * Either way the server has the final word — `lib/calls/start-web-call.ts`
 * refuses a flagged Appointment before it claims the Quota, and it refuses a
 * forged POST exactly the same way.
 */
export function CallNowButton({
  appointmentId,
  name,
  blocked = false,
}: {
  appointmentId: string
  name: string
  /** This Appointment needs attention. Callzie will not call it. */
  blocked?: boolean
}) {
  const { busy, start } = useLiveCall()

  const title = blocked
    ? "This appointment needs attention. Clear it first."
    : busy
      ? "Finish the call in progress first"
      : undefined

  return (
    <Button
      size="sm"
      disabled={busy || blocked}
      title={title}
      onClick={() => start({ appointmentId, name })}
    >
      <Phone aria-hidden />
      Call now
      {/* Seven identical buttons in a table are seven identical announcements
          without this. */}
      <span className="sr-only"> — {name}</span>
    </Button>
  )
}
```

- [ ] **Step 6: Pass it through, in both layouts**

`components/overview/appointments-table.tsx` renders `CallNowButton` twice — once in the `<table>` and once in the `<ul>` below `md`. **Change both.** Each becomes:

```tsx
                  <CallNowButton
                    appointmentId={appointment.id}
                    name={appointment.name}
                    blocked={appointment.needsAttentionReason !== null}
                  />
```

Also update the file's header comment. Replace:

```
 * Not here, deliberately: Call all (#17), the Needs Attention section (#15).
```

with:

```
 * Not here, deliberately: Call all (#17). The Needs Attention section is its
 * own surface above this one; what reaches the table from it is `blocked` on
 * each row's Call now button.
```

- [ ] **Step 7: Check the whole thing**

Run: `npm test && npm run typecheck && npm run lint`

Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add lib/business/list-appointments.ts lib/business/list-appointments.test.ts components/calls/call-now-button.tsx components/overview/appointments-table.tsx
git commit -m "Stop the table offering a Call that would be refused"
```

---

## Task 11: Prove it by replay

The end-to-end proof, with no telephony spend. This is also where the plan pays back the thing reading the script turned up.

**Files:**
- Modify: `scripts/replay-webhook.ts`

**The problem, stated plainly.** Line 236 builds one Call per scenario at `attempt: index + 1`. The `no-answer` scenario is index 1, so it is **attempt 2** — which is `MAX_CALL_ATTEMPTS`. From Task 3 onwards, that delivery flags the throwaway Appointment `unreachable`. The `book_failure` step at line 394 then runs against a row that is already flagged and already `unreachable`.

It would still pass, because `lib/tools/book-slot.ts:136` writes `book_failed` unconditionally and overwrites it. Passing for that reason is worse than failing.

- [ ] **Step 1: Add the import**

At the top of `scripts/replay-webhook.ts`, beside the other `@/lib` imports:

```ts
import { clearNeedsAttention } from "@/lib/appointments/clear-attention";
```

- [ ] **Step 2: Assert the new path, then clear it**

Immediately after the `console.log` about the concurrency banner (the block ending around line 392) and **before** the `// ── 5. the book_slot failure` heading, insert:

```ts
    // ── 4b. the final no-answer ──────────────────────────────────────────
    heading("Nobody answered, for the last time");

    /*
      The `no-answer` Call above is attempt 2, which is MAX_CALL_ATTEMPTS — so
      that delivery has just written SPEC.md §5's fourth reason. Nothing here
      arranged that; it is what `attempt: index + 1` produces, which is why this
      assertion goes in rather than the scenario being renumbered around it.
    */
    const unreachable = await db.query.appointments.findFirst({
      where: eq(schema.appointments.id, appointment.id),
    });
    expect(
      "the final no-answer needs attention",
      unreachable!.needsAttentionReason,
      "unreachable",
    );
    expect("  and the status says so too", unreachable!.status, "unreachable");
    /*
      SPEC.md §14 rule 2, the one this whole reason exists for: an unanswered
      phone is not a cancellation, so the Slot is still held. `unreachable` is
      absent from SLOT_FREEING_STATUSES, so the exclusion constraint is still
      holding this range against every other Appointment.
    */
    expect(
      "  and it keeps its Slot",
      unreachable!.startsAt.toISOString(),
      startsAt.toISOString(),
    );

    /*
      Now clear it, through the same function the Clear button calls. Two things
      at once: it proves the only resolution SPEC.md §5 allows, and it hands the
      book_slot step below a clean row.

      Without this the next step would assert `book_failed` on an Appointment
      that was already flagged `unreachable`, and pass — because
      lib/tools/book-slot.ts writes its reason unconditionally and would
      overwrite it. A step that passes for that reason proves nothing.
    */
    await clearNeedsAttention(business.id, appointment.id);

    const cleared = await db.query.appointments.findFirst({
      where: eq(schema.appointments.id, appointment.id),
    });
    expect("Clear makes it callable again", cleared!.needsAttentionReason, null);
    expect(
      "  without touching the Slot",
      cleared!.startsAt.toISOString(),
      startsAt.toISOString(),
    );
    /*
      And the status is deliberately still `unreachable`. Clearing says a human
      has looked, not that the person turned out to be reachable.
    */
    expect("  or the status", cleared!.status, "unreachable");

    /*
      Scaffolding, not product behaviour: put the row back to `pending` so the
      book_slot step below starts where a live Appointment would. Clearing does
      not do this, and should not.
    */
    await db
      .update(schema.appointments)
      .set({ status: "pending" })
      .where(eq(schema.appointments.id, appointment.id));
```

- [ ] **Step 3: Run the replay**

You need the app running and a real database. In one terminal:

```bash
npm run dev
```

In another:

```bash
npm run replay-webhook
```

Expected: the run ends with `Everything passed. The webhook is safe to point a real Call at.` and the new section prints six passing checks under **Nobody answered, for the last time**.

If the `book_slot` step now fails with "No Slot to lose", the next fourteen days are full for the seeded Business — check Business Hours in Settings. That failure is unrelated to this change.

- [ ] **Step 4: Commit**

```bash
git add scripts/replay-webhook.ts
git commit -m "Prove the unreachable path, and clean up after it"
```

---

## Task 12: Full suite, and the docs

- [ ] **Step 1: Run everything**

```bash
npm test && npm run typecheck && npm run lint
```

Expected: all clean. If anything fails here that passed in its own task, it is almost certainly `lib/webhooks/process.test.ts` or `lib/calls/record.test.ts` — those two touch the same Appointment states the new writer touches.

- [ ] **Step 2: Mark the design implemented**

In `docs/superpowers/specs/2026-08-21-needs-attention-surface-design.md`, change the Status line to:

```markdown
**Status:** Implemented. See `docs/superpowers/plans/2026-08-21-needs-attention-surface.md`
```

That is the only edit. If anything else in the design no longer matches what was built, change the design to say what is true — a spec that describes a version of the code that never shipped is worse than no spec.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-08-21-needs-attention-surface-design.md
git commit -m "Mark the Needs Attention design implemented"
```

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin anushapundir/the-needs-attention-surface
gh pr create --fill
```

The PR body should say what the README will eventually have to: `collision` has no writer until #20, so one of the four rows is renderable but not yet producible.

---

## Acceptance criteria → where each is proved

| Criterion | Proved by |
|---|---|
| Each of the four reasons is set by its own path and shows a specific, human-readable explanation | `book_failed` — `lib/tools/book-slot.ts:136`, already built. `negotiation_truncated` — `lib/calls/record.ts:141` and `lib/extraction/outcome.ts:119`, already built. `unreachable` — Tasks 1-3. `collision` — #20's writer; the sentence and the row are Tasks 6 and 8. Sentences: `lib/appointments/attention-reason.test.ts` |
| An Appointment needing attention cannot be called, individually or via Call All | Task 4. `lib/calls/start-web-call.test.ts` — refused on all four reasons, the Quota unchanged, Retell never contacted. Call all inherits it because `startWebCall` is the only dialling path |
| Clearing restores it to callable without altering its Slot or status | Task 5, `"changes nothing else about it"` compares the whole row. Task 4's `"is callable again once the reason is cleared"` proves the restore |
| The section is hidden when empty and counted in the stat strip | Task 8, `"renders nothing at all when there is nothing wrong"`. The count was already built — `lib/business/appointment-stats.test.ts:110` |
| An unreachable Appointment keeps its Slot held (SPEC.md §14 rule 2) | Task 2, `"writes both columns and holds the Slot"` and `"leaves the database itself refusing to take the Slot"` — the second inserts an overlapping Appointment and proves the EXCLUDE constraint still refuses. Task 3, `"keeps the Slot"`. Task 11, over a real webhook delivery |
| Nothing here auto-resolves | Structural: the only write that nulls the column is `clearNeedsAttention`, and its only caller is `clearAttentionAction`, whose only caller is a button. Task 5's `"is a no-op on an Appointment that is already clear"` and Task 11's ordering both depend on it |

## What this ticket does not do

- **Write `collision`.** #20, with ADR-0004 and the Google flag behind it. The surface renders it; nothing produces one yet.
- **Retry or throttle on no answer.** #17. `MAX_CALL_ATTEMPTS` and `wasFinalNoAnswer` are the two things it will change.
- **Gate the Tool endpoints.** The rule is "no further calling", and no Call can start on a flagged Appointment, so no Tool can run mid-conversation.
- **Bulk clear, or notifications of any kind.** Not in SPEC.md.
