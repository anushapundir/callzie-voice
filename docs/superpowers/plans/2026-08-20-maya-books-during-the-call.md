# Maya books through the Tools, during the call — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A multi-round negotiation on a live Web Call ends with the Appointment moved to the agreed Slot before the person hangs up — and when `book_slot` fails instead, Maya promises a callback, a human is asked to look at it, and she never claims the booking worked.

**Architecture:** Three small changes to code that already works. `check_availability` subtracts the Slots this Call already offered, so round two moves on instead of repeating itself. Every Tool result carries a `say` — the exact words Maya is handed — which puts SPEC.md §3 rule 7 in the endpoint rather than in the prompt. And one pure function decides whether a Call was cut off mid-negotiation, called from `recordCallEnded` now and from #13's webhook later.

**Tech Stack:** Next.js 16 App Router route handlers, TypeScript, Drizzle + Postgres, Vitest against the embedded Postgres in `vitest.globalSetup.ts`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-20-maya-books-during-the-call-design.md`

---

## Two refinements to the spec, made while writing this plan

1. **No `fixtures/retell/tools/book-slot-taken.json`.** A `book_slot` failure is
   forced by *state*, not by the payload — the constraint refuses the write
   because another Appointment holds the Slot. So a second fixture file would be
   byte-identical to `book-slot.json` apart from a placeholder the test fills in
   anyway. The existing fixture plus a seeded competing Appointment reproduces
   the whole path with no spend, which is what acceptance criterion 6 asks for.
   `fixtures/retell/tools/README.md` gains a paragraph saying why.

2. **The retry-count test gets its own file**, `lib/tools/book-slot-retry.test.ts`.
   Counting the two attempts needs `vi.mock` on `@/lib/appointments/reschedule`,
   and `vi.mock` is hoisted to the top of whichever file it appears in. Putting
   it in the existing `book-slot.test.ts` would mock the module for eleven tests
   that want the real one.

---

## File structure

**New**

| File | Responsibility |
|---|---|
| `lib/tools/say.ts` | Every sentence a Tool can hand Maya, in two groups. Pure data |
| `lib/tools/say.test.ts` | Proves no failure line can be read as a success |
| `lib/tools/committed.ts` | Did any Tool write an outcome on this Call? |
| `lib/tools/book-slot-retry.test.ts` | Two attempts, counted through a spy |
| `lib/calls/truncation.ts` | The truncation rule. Pure, no database |
| `lib/calls/truncation.test.ts` | Its table of cases |
| `docs/adr/0012-the-tool-supplies-the-sentence.md` | Decisions 3 and 4, with what was rejected |

**Modified**

| File | Change |
|---|---|
| `lib/tools/check-availability.ts` | Subtract this Call's earlier Offers; `say` when empty |
| `lib/tools/book-slot.ts` | `say` on every return |
| `lib/tools/confirm-appointment.ts` | `say` on success |
| `lib/tools/cancel-appointment.ts` | `say` on success |
| `lib/tools/run.ts` | `say` on the two catch-path results |
| `lib/calls/record.ts` | Write `negotiation_truncated` when a Call was cut off |
| `lib/retell/templates.ts` | The empty-Availability branch and the `say` line |
| `lib/tools/check-availability.test.ts` | Rounds are disjoint; the empty result carries `say` |
| `lib/tools/book-slot.test.ts` | Every refusal assertion gains `say` |
| `lib/tools/run.test.ts` | The two catch-path assertions gain `say` |
| `lib/calls/record.test.ts` | Truncation; `cleanupFor` learns about `tool_invocations` |
| `app/api/tools/routes.test.ts` | Multi-round negotiation; the forced failure |
| `scripts/try-tools.ts` | A forced-failure leg |
| `fixtures/retell/tools/README.md` | Why the failure is forced by state, not by payload |
| `docs/verification.md` | A4 and A12 answered after the live Call |

---

### Task 0: Install dependencies and get a green baseline

`node_modules/` is absent in this worktree. Nothing below can run until it
exists, and a green baseline means every later failure belongs to this work.

**Files:**
- None modified.

- [x] **Step 1: Install**

```bash
npm install
```

- [x] **Step 2: Run the whole suite**

Run: `npm test`
Expected: every test passes. Vitest starts an embedded Postgres first, so the
first run takes longer than later ones. **If anything fails, stop and report — do
not build on a red baseline.**

- [x] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

---

### Task 1: `lib/tools/say.ts` — the words Maya is handed

The whole ticket's safety property lives in this file. Two groups: lines that may
tell someone something was committed, and lines that must not. A test holds the
second group to that.

**Files:**
- Create: `lib/tools/say.ts`
- Create: `lib/tools/say.test.ts`

- [x] **Step 1: Write the failing test**

Create `lib/tools/say.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { COMMITTED, NOT_COMMITTED, sayForError } from "@/lib/tools/say";

/*
  SPEC.md §3 rule 7 and §14 rule 4: Maya must never state that a booking
  succeeded when the Tool call failed. This is the most damaging failure
  available to this product, so the words are owned by the endpoint rather than
  left to the prompt — the same reasoning SPEC.md §3 rule 6 gives for Business
  Hours.

  What this file guards is small and specific: nobody softens a failure line into
  a reassuring one during a later edit.
*/

/** Phrases that would tell a customer their appointment is settled. */
const SOUNDS_LIKE_SUCCESS = [
  "all set",
  "locked in",
  "booked",
  "confirmed",
  "you're set",
  "sorted",
];

describe("NOT_COMMITTED", () => {
  it.each(Object.entries(NOT_COMMITTED))(
    "%s never sounds like a booking happened",
    (_key, line) => {
      for (const phrase of SOUNDS_LIKE_SUCCESS) {
        expect(line.toLowerCase()).not.toContain(phrase);
      }
    },
  );

  it.each(Object.entries(NOT_COMMITTED))("%s is a whole sentence", (_key, line) => {
    // Read aloud by a voice model. A fragment reads as a fragment.
    expect(line.length).toBeGreaterThan(20);
    expect(line.endsWith(".")).toBe(true);
  });

  it("offers a callback whenever a booking was attempted and did not happen", () => {
    expect(NOT_COMMITTED.bookFailed).toContain("call you back");
    expect(NOT_COMMITTED.nothingOpen).toContain("call you back");
    expect(NOT_COMMITTED.wentWrong).toContain("call you back");
  });
});

describe("COMMITTED", () => {
  it("reads the booked time back to the customer", () => {
    // SPEC.md §7 step 3: "call book_slot and read the booked time back to them".
    expect(COMMITTED.booked("Monday 17 August at 10:00 AM")).toContain(
      "Monday 17 August at 10:00 AM",
    );
  });
});

describe("sayForError", () => {
  it("promises a callback when a booking blew up", () => {
    // An unexpected error during book_slot is indistinguishable, to the person
    // on the phone, from a Slot that was taken. Both mean: not booked, someone
    // will ring you.
    expect(sayForError("book_slot")).toBe(NOT_COMMITTED.bookFailed);
  });

  it("stays vague about a Tool that was not booking anything", () => {
    expect(sayForError("check_availability")).toBe(NOT_COMMITTED.wentWrong);
    expect(sayForError("confirm_appointment")).toBe(NOT_COMMITTED.wentWrong);
    expect(sayForError("cancel_appointment")).toBe(NOT_COMMITTED.wentWrong);
  });
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/tools/say.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/tools/say"`.

- [x] **Step 3: Write the module**

Create `lib/tools/say.ts`:

```ts
import type { ToolName } from "@/lib/db/schema";

/**
 * What Maya says, chosen by the endpoint rather than by the prompt.
 *
 * SPEC.md §3 rule 6 settles Business Hours in the Tool because "a prompt
 * instruction is a suggestion". The same argument applies to the sentence
 * itself, and it applies hardest to the failure lines: a response that reads
 * `{ ok: false, reason: "slot_taken" }` leaves the model to compose an answer,
 * and the wrong answer there is SPEC.md §14 rule 4 — claiming a booking that did
 * not happen.
 *
 * **Honest about the limit.** Retell's `speak_after_execution` has the model
 * generate speech *from* the tool response, so it may paraphrase. What it cannot
 * do is read a response whose every field says this did not work and conclude
 * that it did.
 *
 * The two groups are the safety property, not tidiness. `lib/tools/say.test.ts`
 * holds `NOT_COMMITTED` to containing no success language, and that test is only
 * meaningful because the lines that *may* claim success live somewhere else.
 */

/** Lines that may tell the customer something was written down. */
export const COMMITTED = {
  /** `time` comes from `lib/tools/spoken-time.ts` — "Monday 17 August at 10:00 AM". */
  booked: (time: string): string => `You're all set for ${time}.`,
  /**
   * A second `book_slot` in one Call, refused by
   * `tool_invocations_one_booking_per_call`.
   *
   * This sits in COMMITTED deliberately. The second Reschedule was refused, but
   * a first one *did* commit earlier in the same Call — so telling the person
   * they are booked is true, and putting it in the other group would make the
   * failure-line test either wrong or toothless.
   */
  alreadyBooked: "You're already booked in — there's nothing else to change.",
  confirmed: "That's locked in, thanks.",
  cancelled: "That's cancelled, thanks for letting me know.",
} as const;

/** Lines for when nothing was written down. None of these may suggest otherwise. */
export const NOT_COMMITTED = {
  /** SPEC.md §8 step 2, verbatim in intent: a callback, never a claim. */
  bookFailed:
    "I couldn't lock that in — I'll have someone call you back to confirm.",
  /**
   * A `slot_start` we never offered, or one that has since passed.
   *
   * Steers her back to `check_availability` rather than to a callback promise,
   * because nothing is actually wrong: she has simply named a time that is not
   * on the table.
   */
  notAvailable: "That time isn't available — let me check what else we have.",
  nothingOpen:
    "I don't have anything open in the next two weeks. " +
    "I'll have someone call you back.",
  wentWrong: "Something went wrong on my end — I'll have someone call you back.",
} as const;

/**
 * The line for `runTool`'s catch-all, which knows the Tool's name and nothing
 * else about what went wrong.
 *
 * A `book_slot` that threw is, to the person on the phone, the same event as a
 * Slot that was taken: not booked, someone will ring. Every other Tool gets the
 * vaguer line, because promising a callback about a failed availability check
 * would be promising the wrong thing.
 */
export function sayForError(name: ToolName): string {
  return name === "book_slot" ? NOT_COMMITTED.bookFailed : NOT_COMMITTED.wentWrong;
}
```

- [x] **Step 4: Run it and watch it pass**

Run: `npx vitest run lib/tools/say.test.ts`
Expected: PASS — 8 tests.

- [x] **Step 5: Commit**

```bash
git add lib/tools/say.ts lib/tools/say.test.ts
git commit -m "Give the Tools the words, not just the reason"
```

---

### Task 2: `check_availability` stops repeating itself

Today a second call in the same conversation returns the same three times Maya
just had refused. The negotiation cannot progress. Subtract the Slots this Call
already offered — the set `book_slot` is already reading.

**Files:**
- Modify: `lib/tools/check-availability.ts`
- Modify: `lib/tools/check-availability.test.ts`

- [x] **Step 1: Write the failing tests**

In `lib/tools/check-availability.test.ts`, add this import at the top, beside the
existing ones:

```ts
import { NOT_COMMITTED } from "@/lib/tools/say";
```

Add these three tests inside the first `describe("checkAvailability", ...)`
block, after `"returns Slots in ascending order"`:

```ts
  it("never offers a time it has already offered on this Call", async () => {
    // SPEC.md §7: "If they reject them, ask what would suit and call
    // check_availability again." Repeating the same three times is not asking
    // again — it is asking the same question louder.
    const first = await offer();
    const second = await offer();

    const alreadySaid = first.slots.map((s) => s.slot_start);
    for (const slot of second.slots) {
      expect(alreadySaid).not.toContain(slot.slot_start);
    }
  });

  it("carries on from where the last round stopped", async () => {
    // 09:00 is held by the Appointment this Call is about, and the Business
    // closes at 17:00, so Monday's open Slots run 10:00 to 16:00.
    const first = await offer();
    const second = await offer();

    expect(first.slots.map((s) => s.time)).toEqual([
      "Monday 17 August at 10:00 AM",
      "Monday 17 August at 11:00 AM",
      "Monday 17 August at 12:00 PM",
    ]);
    expect(second.slots.map((s) => s.time)).toEqual([
      "Monday 17 August at 1:00 PM",
      "Monday 17 August at 2:00 PM",
      "Monday 17 August at 3:00 PM",
    ]);
  });

  it("still offers a Slot that only a failed check ever named", async () => {
    // A check that failed offered nothing, whatever is in its result — the same
    // rule lib/tools/offers.ts states for book_slot. Narrowing the next round
    // because of a row nobody heard would silently shrink the conversation.
    await db.insert(schema.toolInvocations).values({
      callId: seed.callId,
      toolName: "check_availability",
      arguments: {},
      // succeeded: false — a check that failed offered nothing, whatever is in
      // its result.
      result: { ok: true, slots: [{ slot_start: "2026-08-17T04:30:00.000Z", time: "x" }] },
      succeeded: false,
      latencyMs: 1,
    });

    const starts = (await offer()).slots.map((s) => s.slot_start);
    expect(starts).toContain("2026-08-17T04:30:00.000Z");
  });
```

Then update the existing empty-list test in the second describe block. Replace:

```ts
    expect(await offer()).toEqual({ ok: true, slots: [] });
```

with:

```ts
    expect(await offer()).toEqual({
      ok: true,
      slots: [],
      // SPEC.md §7's prompt has no branch for "nothing open", so an unguided
      // model improvises one. The endpoint supplies the words instead.
      say: NOT_COMMITTED.nothingOpen,
    });
```

- [x] **Step 2: Run and watch them fail**

Run: `npx vitest run lib/tools/check-availability.test.ts`
Expected: FAIL — three failures. `"never offers a time it has already offered"`
finds the same Slots in both rounds, `"carries on from where the last round
stopped"` gets 10:00/11:00/12:00 twice, and the empty-list test is missing `say`.
`"still offers a Slot that only a failed check ever named"` passes already; that
is fine, it is there to stop the next step over-reaching.

- [x] **Step 3: Make the change**

In `lib/tools/check-availability.ts`, add two imports beside the existing ones:

```ts
import { offeredSlotsInCall } from "@/lib/tools/offers";
import { NOT_COMMITTED } from "@/lib/tools/say";
```

Add `say` to the result type:

```ts
export type CheckAvailabilityResult = {
  ok: true;
  slots: OfferedSlot[];
  /** Only when there is nothing to offer. Otherwise she offers `slots` herself. */
  say?: string;
};
```

Replace the body of `checkAvailability` with:

```ts
export const checkAvailability: ToolHandler = async ({ tx, context, now }) => {
  /*
    Every Slot this Call has already named. The same query `book_slot` runs to
    prove an Offer (ADR-0011), read here for the opposite purpose: not to check
    what we may honour, but to avoid saying it twice.
  */
  const alreadyOffered = await offeredSlotsInCall(tx, context.callId);

  const slots = await findAvailableSlots({
    businessId: context.businessId,
    serviceId: context.serviceId,
    from: now,
    to: new Date(now.getTime() + LOOKAHEAD_DAYS * MS_PER_DAY),
    now,
    // Through the transaction, never the pool. `runTool` is already holding a
    // connection, and reaching for a second one deadlocks under concurrency —
    // see `Queryable` in lib/db/index.ts.
    database: tx,
  });

  /*
    Filtered before the slice, not after: taking three and then dropping the
    repeats would return one or two times when six were open.

    Compared on `toISOString()`, the same token `offeredSlotsInCall` stores and
    the same one `book_slot` normalises to, so there is exactly one spelling of
    an instant in this path.
  */
  const fresh = slots.filter(
    (slot) => !alreadyOffered.has(slot.startsAt.toISOString()),
  );

  const result: CheckAvailabilityResult = {
    ok: true,
    slots: fresh.slice(0, MAX_OFFERS).map((slot) => ({
      /*
        ISO 8601, and the token book_slot must echo back. ISO rather than an
        opaque hash because #16 has to render it and a support conversation has
        to be able to read it — lib/tools/offers.ts is what makes it unforgeable,
        not its shape.
      */
      slot_start: slot.startsAt.toISOString(),
      // What Maya says. A different format for a different job — see
      // lib/tools/spoken-time.ts.
      time: spokenTime(slot.startsAt, context.timezone),
    })),
  };

  /*
    Nothing left to offer — either the fortnight is full, or this Call has worked
    through everything in it. No `say` when there *are* Slots: Maya has to offer
    three times in her own words and react to the answer, and a script there
    would make her sound like an IVR.
  */
  if (result.slots.length === 0) result.say = NOT_COMMITTED.nothingOpen;

  /*
    `succeeded: true` even with an empty list. A fully booked fortnight is a fact
    about the Business, not a Tool failure — and recording it as one would make
    Maya say she will have someone call back (SPEC.md §8) about a question that
    was answered correctly.
  */
  return { succeeded: true, result };
};
```

Also update the module docstring: replace the paragraph beginning
`"preferred_time" is deliberately unused.` with:

```
 * Two rounds of this Tool in one Call return different times. The Slots this
 * Call has already named are subtracted, because SPEC.md §7's negotiation
 * requires "ask what would suit and call check_availability again" to mean
 * something — repeating the same three times is asking the same question louder.
 *
 * Note the asymmetry with `book_slot`, which is deliberate: this refuses to
 * *re-offer* a time, and `book_slot` still honours any time named at any point
 * in the Call. "Actually, the first one you said" is a real thing people say.
 *
 * `preferred_time` is deliberately unused. It is still recorded — `runTool`
 * writes every argument to `tool_invocations` — so the phrases people really use
 * can be read off the table before a parser is written for imagined ones. See
 * the design doc's known limitations.
```

- [x] **Step 4: Run and watch them pass**

Run: `npx vitest run lib/tools/check-availability.test.ts`
Expected: PASS — 11 tests.

- [x] **Step 5: Run every test that touches these Tools**

Run: `npx vitest run lib/tools app/api/tools`
Expected: PASS. The dedup changes what a second `check_availability` returns, and
`book-slot.test.ts`, `run.test.ts`, `concurrency.test.ts` and `routes.test.ts`
all call it more than once — but none of them asserts that two rounds match, so
they should all still pass. **If any fails, read it before changing it:** a
genuine break here means the dedup reached further than intended.

- [x] **Step 6: Commit**

```bash
git add lib/tools/check-availability.ts lib/tools/check-availability.test.ts
git commit -m "Stop offering the same three times the customer just refused"
```

---

### Task 3: `book_slot` speaks its own outcome

**Files:**
- Modify: `lib/tools/book-slot.ts`
- Modify: `lib/tools/book-slot.test.ts`

- [x] **Step 1: Write the failing tests**

In `lib/tools/book-slot.test.ts`, add the import:

```ts
import { COMMITTED, NOT_COMMITTED } from "@/lib/tools/say";
```

Widen the result type near the top of the file:

```ts
type BookResult = {
  ok: boolean;
  booked_time?: string;
  reason?: string;
  say?: string;
};
```

Now update every assertion that compares a whole result object. There are six,
and each gains one line:

Line ~129, `"refuses a time it never offered"`:

```ts
    expect(await book(OPEN_BUT_NEVER_OFFERED)).toEqual({
      ok: false,
      reason: "not_offered",
      say: NOT_COMMITTED.notAvailable,
    });
```

Line ~159, `"refuses a Slot offered on some other Call"`:

```ts
    expect(await book(OPEN_BUT_NEVER_OFFERED)).toEqual({
      ok: false,
      reason: "not_offered",
      say: NOT_COMMITTED.notAvailable,
    });
```

Line ~173, the `it.each` over bad `slot_start` values:

```ts
    expect(await book(value)).toEqual({
      ok: false,
      reason: "invalid_time",
      say: NOT_COMMITTED.notAvailable,
    });
```

Line ~182, `"refuses an offered Slot that has since passed"`:

```ts
    expect(await book(first.slot_start, later)).toEqual({
      ok: false,
      reason: "in_the_past",
      say: NOT_COMMITTED.notAvailable,
    });
```

Line ~197, `"refuses an offered Slot the Business has since closed"`:

```ts
    expect(await book(first.slot_start)).toEqual({
      ok: false,
      reason: "not_offered",
      say: NOT_COMMITTED.notAvailable,
    });
```

Line ~204, `"fails cleanly when another Call took the Slot first"`:

```ts
    expect(await book(first.slot_start)).toEqual({
      ok: false,
      reason: "slot_taken",
      // SPEC.md §8 step 2: a callback, never a claim.
      say: NOT_COMMITTED.bookFailed,
    });
```

Line ~223, the recorded row in `"records the failed booking..."`:

```ts
    expect(booking!.result).toEqual({
      ok: false,
      reason: "slot_taken",
      say: NOT_COMMITTED.bookFailed,
    });
```

Line ~238, `"refuses a second booking..."` — this one comes from `runTool`'s
catch path and is fixed in Task 4, so leave it alone for now.

Finally, add one new test at the end of the `describe("bookSlotTool", ...)`
block:

```ts
  it("hands Maya the booked time to read back", async () => {
    // SPEC.md §7 step 3: "call book_slot and read the booked time back to them."
    const [first] = (await check()).slots;

    const result = await book(first.slot_start);

    expect(result.say).toBe(COMMITTED.booked(first.time));
    expect(result.say).toContain(first.time);
  });
```

- [x] **Step 2: Run and watch them fail**

Run: `npx vitest run lib/tools/book-slot.test.ts`
Expected: FAIL — the `toEqual` assertions report a missing `say` key, and the new
test finds `undefined`.

- [x] **Step 3: Make the change**

In `lib/tools/book-slot.ts`, add the import:

```ts
import { COMMITTED, NOT_COMMITTED } from "@/lib/tools/say";
```

Replace the `refuse` helper:

```ts
/**
 * A refusal, with the words that go with it.
 *
 * `slot_taken` is the only one that promises a callback, because it is the only
 * one where Maya asked for something reasonable and Callzie could not deliver
 * it. The other three mean she named a time that was never on the table, and the
 * right move there is another `check_availability`, not a promise to ring back.
 */
const refuse = (reason: BookSlotRefusal): ToolOutcome => ({
  succeeded: false,
  result: {
    ok: false,
    reason,
    say:
      reason === "slot_taken"
        ? NOT_COMMITTED.bookFailed
        : NOT_COMMITTED.notAvailable,
  },
});
```

Replace the success return inside the retry loop:

```ts
    if (moved.ok) {
      // Read back to the customer — SPEC.md §7 step 3.
      const spoken = spokenTime(startsAt, context.timezone);

      return {
        succeeded: true,
        result: {
          ok: true,
          booked_time: spoken,
          say: COMMITTED.booked(spoken),
        },
      };
    }
```

- [x] **Step 4: Run and watch them pass**

Run: `npx vitest run lib/tools/book-slot.test.ts`
Expected: FAIL on exactly one test — `"refuses a second booking while still
answering check_availability"`, whose `already_booked` result comes from
`runTool`. Everything else passes. Task 4 closes it.

- [x] **Step 5: Commit**

```bash
git add lib/tools/book-slot.ts lib/tools/book-slot.test.ts
git commit -m "Let book_slot say what happened, in words that cannot be misread"
```

---

### Task 4: `confirm`, `cancel` and the catch-all speak too

**Files:**
- Modify: `lib/tools/confirm-appointment.ts`
- Modify: `lib/tools/cancel-appointment.ts`
- Modify: `lib/tools/run.ts`
- Modify: `lib/tools/run.test.ts`
- Modify: `lib/tools/book-slot.test.ts`

- [x] **Step 1: Write the failing tests**

In `lib/tools/run.test.ts`, add the import:

```ts
import { COMMITTED, NOT_COMMITTED } from "@/lib/tools/say";
```

Line ~107, `"records a handler that threw, and does not rethrow"`:

```ts
    expect(result).toEqual({
      ok: false,
      reason: "error",
      // The tool was book_slot, so this is a callback promise rather than the
      // vaguer line.
      say: NOT_COMMITTED.bookFailed,
    });
```

Line ~152, `"refuses a second successful book_slot in the same Call"`:

```ts
    expect(await booking()).toEqual({ ok: true });
    expect(await booking()).toEqual({
      ok: false,
      reason: "already_booked",
      say: COMMITTED.alreadyBooked,
    });
```

(The first `{ ok: true }` is a stub handler's own result and does not change.)

Add one new test at the end of `describe("runTool", ...)`:

```ts
  it("stays vague when a Tool that was not booking anything blows up", async () => {
    const result = await runTool({
      name: "check_availability",
      args: {},
      context,
      handler: async () => {
        throw new Error("the database went away");
      },
    });

    // Promising a callback about a failed availability check would promise the
    // wrong thing.
    expect(result).toEqual({
      ok: false,
      reason: "error",
      say: NOT_COMMITTED.wentWrong,
    });
  });
```

In `lib/tools/book-slot.test.ts`, line ~238:

```ts
    expect(await book(second.slots[0].slot_start)).toEqual({
      ok: false,
      reason: "already_booked",
      say: COMMITTED.alreadyBooked,
    });
```

- [x] **Step 2: Run and watch them fail**

Run: `npx vitest run lib/tools/run.test.ts lib/tools/book-slot.test.ts`
Expected: FAIL — four failures, each a missing `say`.

- [x] **Step 3: Make the change**

In `lib/tools/run.ts`, add the import:

```ts
import { COMMITTED, sayForError } from "@/lib/tools/say";
```

Replace the result construction inside the `catch`:

```ts
    /*
      This is the only code that inserts into `tool_invocations`, so it is the
      only code positioned to recognise that table's constraints. Knowing about
      book_slot here is a small impurity paid for by that.

      Both branches carry the words as well as the reason. A 500 tells Maya
      nothing; a body that says ok:false and hands her a sentence tells her what
      to do next (SPEC.md §3 rule 7).
    */
    const result = isSecondBooking(error)
      ? { ok: false, reason: "already_booked", say: COMMITTED.alreadyBooked }
      : { ok: false, reason: "error", say: sayForError(name) };
```

In `lib/tools/confirm-appointment.ts`, add the import and the field:

```ts
import { COMMITTED } from "@/lib/tools/say";
```

```ts
  return { succeeded: true, result: { ok: true, say: COMMITTED.confirmed } };
```

In `lib/tools/cancel-appointment.ts`, the same:

```ts
import { COMMITTED } from "@/lib/tools/say";
```

```ts
  return { succeeded: true, result: { ok: true, say: COMMITTED.cancelled } };
```

- [x] **Step 4: Run and watch them pass**

Run: `npx vitest run lib/tools`
Expected: PASS for every file except `app/api/tools/routes.test.ts`, which is not
in this path. `confirm-cancel.test.ts` asserts on the Appointment row rather than
on the whole result body, so it is unaffected.

- [x] **Step 5: Fix the two route assertions this broke**

In `app/api/tools/routes.test.ts`, add the import:

```ts
import { COMMITTED, NOT_COMMITTED } from "@/lib/tools/say";
```

Line ~171:

```ts
    expect(again).toEqual({
      ok: false,
      reason: "already_booked",
      say: COMMITTED.alreadyBooked,
    });
```

Line ~213:

```ts
    expect(await response.json()).toEqual({ ok: true, say: COMMITTED.confirmed });
```

Line ~229:

```ts
    expect(await response.json()).toEqual({ ok: true, say: COMMITTED.cancelled });
```

Line ~243:

```ts
    expect(await response.json()).toEqual({
      ok: false,
      reason: "not_offered",
      say: NOT_COMMITTED.notAvailable,
    });
```

- [x] **Step 6: Run the routes**

Run: `npx vitest run app/api/tools/routes.test.ts`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add lib/tools/confirm-appointment.ts lib/tools/cancel-appointment.ts \
        lib/tools/run.ts lib/tools/run.test.ts lib/tools/book-slot.test.ts \
        app/api/tools/routes.test.ts
git commit -m "Every Tool result now carries the sentence that goes with it"
```

---

### Task 5: `lib/calls/truncation.ts` — was the negotiation cut off?

A pure function over three facts. `recordCallEnded` calls it with what the server
can prove today; #13's webhook calls it with Retell's own reason.

**Files:**
- Create: `lib/calls/truncation.ts`
- Create: `lib/calls/truncation.test.ts`

- [x] **Step 1: Write the failing test**

Create `lib/calls/truncation.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  MAX_DURATION_REACHED,
  NEAR_CAP_SECONDS,
  wasNegotiationTruncated,
} from "@/lib/calls/truncation";

/*
  SPEC.md §5: `negotiation_truncated` is set when a Call hit the 120s cap with no
  Tool committed. Callzie will not call that person again until a human clears it.

  Pure, so every case is here rather than reachable only by holding a real
  conversation for two minutes.
*/

describe("wasNegotiationTruncated", () => {
  it("is false whenever a Tool committed, however long the Call ran", () => {
    // A Call that booked, confirmed or cancelled has an outcome. Whatever else
    // happened to it, nothing was truncated.
    expect(
      wasNegotiationTruncated({ durationSeconds: 120, committed: true }),
    ).toBe(false);
  });

  it("is false even for Retell's own cap reason when a Tool committed", () => {
    expect(
      wasNegotiationTruncated({
        durationSeconds: 120,
        committed: true,
        disconnectionReason: MAX_DURATION_REACHED,
      }),
    ).toBe(false);
  });

  it("trusts Retell's reason over the clock", () => {
    // #13 supplies this. A Call the cap ended is truncated whatever the recorded
    // duration says.
    expect(
      wasNegotiationTruncated({
        durationSeconds: 3,
        committed: false,
        disconnectionReason: MAX_DURATION_REACHED,
      }),
    ).toBe(true);
  });

  it("falls back to the duration when nobody said why the Call ended", () => {
    // The Web Call path. The browser reports that the Call ended, not why.
    expect(
      wasNegotiationTruncated({
        durationSeconds: NEAR_CAP_SECONDS,
        committed: false,
      }),
    ).toBe(true);
  });

  it("leaves a short Call alone", () => {
    // A wrong number or a voicemail is over in seconds and is not a negotiation
    // that ran out of time. #14's extraction covers those.
    expect(
      wasNegotiationTruncated({ durationSeconds: 12, committed: false }),
    ).toBe(false);
  });

  it("leaves a Call that never started alone", () => {
    // `duration_seconds` is null until a Call ends. A missing number is not a
    // long one.
    expect(
      wasNegotiationTruncated({ durationSeconds: null, committed: false }),
    ).toBe(false);
  });

  it("ignores a disconnection reason that means something else", () => {
    // docs/verification.md A9: an expired access token produces this one.
    expect(
      wasNegotiationTruncated({
        durationSeconds: 4,
        committed: false,
        disconnectionReason: "error_user_not_joined",
      }),
    ).toBe(false);
  });
});
```

- [x] **Step 2: Run and watch it fail**

Run: `npx vitest run lib/calls/truncation.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/calls/truncation"`.

- [x] **Step 3: Write the module**

Create `lib/calls/truncation.ts`:

```ts
/**
 * Whether a Call ran out of time before anything was agreed.
 *
 * SPEC.md §5's fourth Needs Attention reason: the Call hit the 120s cap with no
 * Tool committed. The Appointment keeps its Slot and waits for a human — Callzie
 * refuses to guess an outcome from a conversation that did not reach one
 * (SPEC.md §14 rule 4, the same instinct as rule 2).
 *
 * **Pure, and called from two places.** `lib/calls/record.ts` calls it now with
 * what the browser's report leaves the server able to prove. #13's webhook calls
 * it later with Retell's own `disconnection_reason`, which is the authoritative
 * answer. One rule, two callers, no second copy to drift.
 */

/** SPEC.md §7's `max_call_duration_ms`, in seconds. The cost guardrail. */
export const CAP_SECONDS = 120;

/**
 * Close enough to the cap to count as having hit it.
 *
 * Five seconds of slack because the SDK's `call_ended` in the browser and
 * Postgres's `now()` are not the same clock, and `recordCallEnded` computes the
 * duration from the second one.
 */
export const NEAR_CAP_SECONDS = 115;

/** Retell's own word for the cap firing (docs/verification.md A9). */
export const MAX_DURATION_REACHED = "max_duration_reached";

export type TruncationInput = {
  /** From `calls.duration_seconds`. Null until a Call has ended. */
  durationSeconds: number | null;
  /**
   * Did any Tool write an outcome on this Call?
   *
   * A successful `check_availability` is not one — it is a question with an
   * answer. See `lib/tools/committed.ts`.
   */
  committed: boolean;
  /**
   * Retell's `disconnection_reason`, when we have it. #13 supplies it; the Web
   * Call path does not, because the browser reports that the Call ended and not
   * why.
   */
  disconnectionReason?: string | null;
};

export function wasNegotiationTruncated({
  durationSeconds,
  committed,
  disconnectionReason,
}: TruncationInput): boolean {
  // An outcome is an outcome. Nothing after this can override it.
  if (committed) return false;

  // The authoritative answer, when there is one.
  if (disconnectionReason === MAX_DURATION_REACHED) return true;

  if (durationSeconds === null) return false;
  return durationSeconds >= NEAR_CAP_SECONDS;
}
```

- [x] **Step 4: Run and watch it pass**

Run: `npx vitest run lib/calls/truncation.test.ts`
Expected: PASS — 7 tests.

- [x] **Step 5: Commit**

```bash
git add lib/calls/truncation.ts lib/calls/truncation.test.ts
git commit -m "Name the Call that ran out of time before anything was agreed"
```

---

### Task 6: `lib/tools/committed.ts` — did any Tool write an outcome?

**Files:**
- Create: `lib/tools/committed.ts`
- Modify: `lib/tools/offers.test.ts` (add a describe block; the file already
  seeds everything this needs)

- [x] **Step 1: Write the failing test**

Append to `lib/tools/offers.test.ts`. First check the existing imports at the top
of that file and add:

```ts
import { hasCommittedOutcome } from "@/lib/tools/committed";
import { db } from "@/lib/db";
```

(`db` and `schema` may already be imported there — do not duplicate an import.)

Add this describe block at the end of the file:

```ts
describe("hasCommittedOutcome", () => {
  /** Write a `tool_invocations` row directly, as a Tool call would. */
  async function record(
    toolName: "check_availability" | "book_slot" | "confirm_appointment" | "cancel_appointment",
    succeeded: boolean,
  ) {
    await db.insert(schema.toolInvocations).values({
      callId: seed.callId,
      toolName,
      arguments: {},
      result: { ok: succeeded },
      succeeded,
      latencyMs: 2,
    });
  }

  it("is false before anything has happened", async () => {
    expect(await hasCommittedOutcome(db, seed.callId)).toBe(false);
  });

  it("is false for a check, which commits nothing", async () => {
    // A successful check_availability is a question with an answer, not an
    // outcome. This distinction is the whole point of the module.
    await record("check_availability", true);
    expect(await hasCommittedOutcome(db, seed.callId)).toBe(false);
  });

  it("is false for a booking that failed", async () => {
    await record("book_slot", false);
    expect(await hasCommittedOutcome(db, seed.callId)).toBe(false);
  });

  it.each(["book_slot", "confirm_appointment", "cancel_appointment"] as const)(
    "is true after a successful %s",
    async (toolName) => {
      await record(toolName, true);
      expect(await hasCommittedOutcome(db, seed.callId)).toBe(true);
    },
  );

  it("does not see another Call's outcome", async () => {
    await record("book_slot", true);
    expect(await hasCommittedOutcome(db, "00000000-0000-0000-0000-000000000000")).toBe(
      false,
    );
  });
});
```

**Note on the seed variable:** `lib/tools/offers.test.ts` already has a `seed`
in scope from its `beforeEach`. Read the top of that file before writing this
block and use whatever name it uses.

- [x] **Step 2: Run and watch it fail**

Run: `npx vitest run lib/tools/offers.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/tools/committed"`.

- [x] **Step 3: Write the module**

Create `lib/tools/committed.ts`:

```ts
import { and, eq, inArray } from "drizzle-orm";

import { schema, type Queryable } from "@/lib/db";

/**
 * Did any Tool write an outcome on this Call?
 *
 * `tool_invocations` is the authoritative record of what happened (SPEC.md §9
 * step 3), so this asks the record rather than inferring from
 * `appointments.status` — which says what the Appointment is now, not what this
 * particular Call decided.
 *
 * Used by `lib/calls/record.ts` to tell a negotiation that ran out of time from
 * one that reached an answer, and by #13's webhook for the same reason.
 */

/**
 * The three Tools that write.
 *
 * `check_availability` is deliberately absent. A successful check is a question
 * with an answer — the Call that asked it three times and then ran out of time
 * is exactly the Call SPEC.md §5 wants flagged.
 */
export const COMMITTING_TOOLS = [
  "book_slot",
  "confirm_appointment",
  "cancel_appointment",
] as const;

export async function hasCommittedOutcome(
  database: Queryable,
  callId: string,
): Promise<boolean> {
  const [row] = await database
    .select({ id: schema.toolInvocations.id })
    .from(schema.toolInvocations)
    .where(
      and(
        eq(schema.toolInvocations.callId, callId),
        // A failed book_slot is the case SPEC.md §8 covers, and it commits
        // nothing — book_slot writes `book_failed` itself when it gives up.
        eq(schema.toolInvocations.succeeded, true),
        inArray(schema.toolInvocations.toolName, [...COMMITTING_TOOLS]),
      ),
    )
    .limit(1);

  return row !== undefined;
}
```

- [x] **Step 4: Run and watch it pass**

Run: `npx vitest run lib/tools/offers.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add lib/tools/committed.ts lib/tools/offers.test.ts
git commit -m "Ask the record whether this Call decided anything"
```

---

### Task 7: `recordCallEnded` flags the truncated negotiation

**Files:**
- Modify: `lib/calls/record.ts`
- Modify: `lib/calls/record.test.ts`

- [x] **Step 1: Teach the test file's cleanup about `tool_invocations`**

This must come first. `cleanupFor` in `lib/calls/record.test.ts` deletes `calls`
without deleting the `tool_invocations` that point at them, so the moment a test
writes one the foreign key refuses the delete and every later test in the file
fails on a dirty fixture.

In `lib/calls/record.test.ts`, inside `cleanupFor`, replace this loop:

```ts
    for (const appointment of appointments) {
      await db
        .delete(schema.calls)
        .where(eq(schema.calls.appointmentId, appointment.id));
    }
```

with:

```ts
    for (const appointment of appointments) {
      const calls = await db
        .select({ id: schema.calls.id })
        .from(schema.calls)
        .where(eq(schema.calls.appointmentId, appointment.id));

      // tool_invocations references calls. Inner first, or the delete is
      // refused by the foreign key.
      for (const call of calls) {
        await db
          .delete(schema.toolInvocations)
          .where(eq(schema.toolInvocations.callId, call.id));
      }

      await db
        .delete(schema.calls)
        .where(eq(schema.calls.appointmentId, appointment.id));
    }
```

- [x] **Step 2: Write the failing tests**

In `lib/calls/record.test.ts`, add to the imports:

```ts
import type { NeedsAttentionReason, ToolName } from "@/lib/db/schema";
```

(The file already imports `AppointmentStatus` from there — extend that import
rather than adding a second one.)

Add these three helpers beside the existing `callRow` and `appointmentStatus`:

```ts
/**
 * Backdate the Call's start, so `recordCallEnded` computes a long duration.
 *
 * The duration is derived in SQL from `started_at`, never taken from the
 * browser, so this is the only way to stage a Call that ran to the cap.
 */
async function startedSecondsAgo(seconds: number) {
  await db
    .update(schema.calls)
    .set({
      status: "in_progress",
      startedAt: new Date(Date.now() - seconds * 1000),
    })
    .where(eq(schema.calls.id, callId));
}

/** Write a `tool_invocations` row, as a Tool call would. */
async function recordTool(toolName: ToolName, succeeded: boolean) {
  await db.insert(schema.toolInvocations).values({
    callId,
    toolName,
    arguments: {},
    result: { ok: succeeded },
    succeeded,
    latencyMs: 2,
  });
}

async function needsAttention(): Promise<NeedsAttentionReason | null> {
  const appointment = await db.query.appointments.findFirst({
    where: eq(schema.appointments.id, appointmentId),
  });
  return appointment!.needsAttentionReason as NeedsAttentionReason | null;
}
```

Add this describe block at the end of the file:

```ts
describe("a negotiation the 120s cap cut off", () => {
  it("asks a human to call back when nothing was committed", async () => {
    await startedSecondsAgo(118);

    await recordCallEnded(businessId, callId);

    expect(await needsAttention()).toBe("negotiation_truncated");
  });

  it("does not record it as a booking", async () => {
    // Acceptance criterion 5. The Appointment goes back to where it genuinely
    // is — nothing decided it — rather than to a status nobody agreed to.
    await startedSecondsAgo(118);

    await recordCallEnded(businessId, callId);

    expect(await appointmentStatus()).toBe("pending");
  });

  it("says nothing about a Call that booked", async () => {
    await startedSecondsAgo(118);
    await recordTool("book_slot", true);

    await recordCallEnded(businessId, callId);

    expect(await needsAttention()).toBeNull();
  });

  it("still flags a Call that only ever asked what was open", async () => {
    // Three rounds of Offers and no answer is exactly the Call SPEC.md §5 wants
    // in front of a human. A check commits nothing.
    await startedSecondsAgo(118);
    await recordTool("check_availability", true);

    await recordCallEnded(businessId, callId);

    expect(await needsAttention()).toBe("negotiation_truncated");
  });

  it("still flags a Call whose booking failed without book_slot's own flag", async () => {
    // A failed book_slot commits nothing. In the real path book_slot has
    // already written `book_failed`, which the next test covers — this one
    // proves the query does not count a failed row as an outcome.
    await startedSecondsAgo(118);
    await recordTool("book_slot", false);

    await recordCallEnded(businessId, callId);

    expect(await needsAttention()).toBe("negotiation_truncated");
  });

  it("never overwrites the more specific book_failed", async () => {
    // A Call that tried and failed to book is not the same as one that never
    // got there, and #15 renders the difference.
    await startedSecondsAgo(118);
    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: "book_failed" })
      .where(eq(schema.appointments.id, appointmentId));

    await recordCallEnded(businessId, callId);

    expect(await needsAttention()).toBe("book_failed");
  });

  it("leaves a short Call alone", async () => {
    // A wrong number is over in seconds. #14's extraction covers those.
    await startedSecondsAgo(15);

    await recordCallEnded(businessId, callId);

    expect(await needsAttention()).toBeNull();
  });

  it("leaves another Business's Call alone", async () => {
    await startedSecondsAgo(118);

    await recordCallEnded(otherBusinessId, callId);

    // Nothing was written at all — not the Call, and not the Appointment.
    expect(await needsAttention()).toBeNull();
    expect((await callRow()).status).toBe("in_progress");
  });
});
```

- [x] **Step 3: Run and watch them fail**

Run: `npx vitest run lib/calls/record.test.ts`
Expected: FAIL — the truncation tests find `null` where they want
`"negotiation_truncated"`. The `book_failed`, short-Call and other-Business tests
pass already; they are there to stop the next step over-reaching.

- [x] **Step 4: Make the change**

In `lib/calls/record.ts`, extend the imports:

```ts
import { and, eq, isNull, sql } from "drizzle-orm";

import { wasNegotiationTruncated } from "@/lib/calls/truncation";
import { db, schema } from "@/lib/db";
import { hasCommittedOutcome } from "@/lib/tools/committed";
```

Replace `recordCallEnded` with:

```ts
/** The Call ended normally. */
export async function recordCallEnded(
  businessId: string,
  callId: string,
): Promise<void> {
  /*
    The duration is computed here, from `started_at`, rather than taken from the
    browser. There is no reason to accept a number we already hold.

    `COALESCE` because `started_at` can be null — a Call that ended without ever
    reporting a start — and `GREATEST(..., 0)` because a negative duration would
    be worse than a zero.
  */
  const [call] = await db
    .update(schema.calls)
    .set({
      status: "completed",
      endedAt: new Date(),
      durationSeconds: sql`GREATEST(EXTRACT(EPOCH FROM (now() - COALESCE(${schema.calls.startedAt}, now())))::int, 0)`,
    })
    .where(and(eq(schema.calls.id, callId), ownedBy(businessId)))
    .returning({
      id: schema.calls.id,
      appointmentId: schema.calls.appointmentId,
      // Read back rather than recomputed here: the number the row holds is the
      // number the truncation rule has to judge.
      durationSeconds: schema.calls.durationSeconds,
    });

  if (!call) return;

  await releaseAppointment(call.appointmentId);

  /*
    SPEC.md §5's fourth Needs Attention reason. The Web Call path knows the Call
    ended but not why, so the rule falls back to the duration — see
    lib/calls/truncation.ts. #13 passes Retell's own `disconnection_reason` into
    the same function and replaces the inference with a fact.
  */
  const committed = await hasCommittedOutcome(db, call.id);
  if (
    wasNegotiationTruncated({
      durationSeconds: call.durationSeconds,
      committed,
    })
  ) {
    await flagTruncated(call.appointmentId);
  }
}
```

Add this function beside `releaseAppointment`:

```ts
/**
 * Asks a human to look at an Appointment whose Call ran out of time.
 *
 * **Only when nothing is flagged already.** `book_slot` may have written
 * `book_failed` moments earlier, and that is the more specific reason: a Call
 * that tried and failed to book is not the same as one that never got there.
 * A conditional UPDATE rather than a read followed by a write, for the reason
 * SPEC.md §3 rule 8 gives.
 *
 * The Appointment keeps its Slot. SPEC.md §14 rule 2 — a Slot is never freed on
 * a weak signal, and a conversation that did not finish is the weakest there is.
 */
async function flagTruncated(appointmentId: string): Promise<void> {
  await db
    .update(schema.appointments)
    .set({ needsAttentionReason: "negotiation_truncated" })
    .where(
      and(
        eq(schema.appointments.id, appointmentId),
        isNull(schema.appointments.needsAttentionReason),
      ),
    );
}
```

Finally, update the file's opening comment. Replace the sentence
`**Nothing here returns a Call to the Quota.**` paragraph's neighbours by adding
this paragraph after it:

```
  `recordCallEnded` also writes SPEC.md §5's `negotiation_truncated`. That is
  the one judgement in this file rather than a plain report, and it is made by a
  pure function in lib/calls/truncation.ts so #13's webhook can make the same one
  from better information.
```

- [x] **Step 5: Run and watch them pass**

Run: `npx vitest run lib/calls/record.test.ts`
Expected: PASS — 20 tests.

- [x] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add lib/calls/record.ts lib/calls/record.test.ts
git commit -m "Flag the Appointment whose Call ran out of time before anything was agreed"
```

---

### Task 8: Drive the whole thing through the routes

The acceptance criteria, driven through the real route handlers by the fixtures,
exactly as Retell would. Nothing here contacts anybody or costs anything.

**Files:**
- Modify: `app/api/tools/routes.test.ts`
- Modify: `fixtures/retell/tools/README.md`

- [x] **Step 1: Write the failing tests**

In `app/api/tools/routes.test.ts`, add this helper beside `rawRequest`:

```ts
/** Park a competing Appointment on a Slot, as a concurrent Call would. */
async function occupy(slotStart: string) {
  await db.insert(schema.appointments).values({
    businessId: seed.businessId,
    serviceId: seed.serviceId,
    name: "Faster Caller",
    phoneE164: "+919876500002",
    startsAt: new Date(slotStart),
    // seedToolTest's Service is 60 minutes.
    endsAt: new Date(new Date(slotStart).getTime() + 60 * 60_000),
    status: "confirmed",
  });
}

type OfferedRow = { slot_start: string; time: string };
```

Add this describe block after `describe("the full negotiation, as Retell would drive it", ...)`:

```ts
describe("the negotiation SPEC.md §7 describes", () => {
  it("offers different times each round and books one of the later ones", async () => {
    // "10am is unavailable, so offer noon; noon is refused, so offer 4pm; 4pm is
    // free, so book it and read it back." Unlimited Offers, exactly one commit.
    const first = await (await checkRoute(toolRequest("check-availability"))).json();
    expect(first.slots.length).toBeGreaterThan(0);

    const second = await (await checkRoute(toolRequest("check-availability"))).json();
    expect(second.slots.length).toBeGreaterThan(0);

    const alreadySaid = first.slots.map((s: OfferedRow) => s.slot_start);
    for (const slot of second.slots as OfferedRow[]) {
      expect(alreadySaid).not.toContain(slot.slot_start);
    }

    const agreed = second.slots[0] as OfferedRow;
    const booked = await (
      await bookSlotRoute(toolRequest("book-slot", { slotStart: agreed.slot_start }))
    ).json();

    expect(booked.ok).toBe(true);
    expect(booked.booked_time).toBe(agreed.time);
    expect(booked.say).toBe(COMMITTED.booked(agreed.time));

    // The row has moved, and it moved during the call rather than afterwards.
    const appointment = await db.query.appointments.findFirst({
      where: eq(schema.appointments.id, seed.appointmentId),
    });
    expect(appointment!.startsAt.toISOString()).toBe(agreed.slot_start);
    expect(appointment!.status).toBe("rescheduled");
    expect(appointment!.needsAttentionReason).toBeNull();
  });

  it("still honours a time from an earlier round", async () => {
    // "Actually, the first one you said" is a real thing people say. The
    // endpoint refuses to re-offer a time; it does not refuse to honour one.
    const first = await (await checkRoute(toolRequest("check-availability"))).json();
    await checkRoute(toolRequest("check-availability"));

    const wanted = first.slots[0] as OfferedRow;
    const booked = await (
      await bookSlotRoute(toolRequest("book-slot", { slotStart: wanted.slot_start }))
    ).json();

    expect(booked.ok).toBe(true);
    expect(booked.booked_time).toBe(wanted.time);
  });

  it("promises a callback when the Slot goes, and never claims success", async () => {
    // SPEC.md §8, the path that matters more than the happy one. Forced from a
    // fixture and seeded state, with no telephony spend (SPEC.md §10).
    const offered = await (await checkRoute(toolRequest("check-availability"))).json();
    const agreed = offered.slots[0] as OfferedRow;

    // Another Call takes it between the Offer and the booking.
    await occupy(agreed.slot_start);

    const response = await bookSlotRoute(
      toolRequest("book-slot", { slotStart: agreed.slot_start }),
    );
    const body = await response.json();

    // A business refusal is part of the conversation, not a broken request.
    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: false,
      reason: "slot_taken",
      say: NOT_COMMITTED.bookFailed,
    });
    // SPEC.md §3 rule 7, as one assertion.
    expect(body.booked_time).toBeUndefined();
    expect(body.say).toContain("call you back");

    const appointment = await db.query.appointments.findFirst({
      where: eq(schema.appointments.id, seed.appointmentId),
    });
    // The Appointment keeps its original Slot (SPEC.md §8 step 3)...
    expect(appointment!.startsAt).toEqual(APPOINTMENT_STARTS_AT);
    // ...and a human is asked to look at it.
    expect(appointment!.needsAttentionReason).toBe("book_failed");

    // The retry is silent to the customer, not to the record.
    const rows = await db
      .select()
      .from(schema.toolInvocations)
      .where(eq(schema.toolInvocations.callId, seed.callId));
    const booking = rows.find((r) => r.toolName === "book_slot");
    expect(booking!.succeeded).toBe(false);
    expect(booking!.arguments).toEqual({ slot_start: agreed.slot_start });
  });

  it("keeps talking after a failed booking", async () => {
    // She has to be able to offer something else. A failed book_slot is not the
    // end of the conversation, and it must not have consumed the one commit.
    const offered = await (await checkRoute(toolRequest("check-availability"))).json();
    const gone = offered.slots[0] as OfferedRow;
    await occupy(gone.slot_start);
    await bookSlotRoute(toolRequest("book-slot", { slotStart: gone.slot_start }));

    const next = await (await checkRoute(toolRequest("check-availability"))).json();
    expect(next.slots.length).toBeGreaterThan(0);

    const second = next.slots[0] as OfferedRow;
    const booked = await (
      await bookSlotRoute(toolRequest("book-slot", { slotStart: second.slot_start }))
    ).json();
    expect(booked.ok).toBe(true);
  });
});
```

- [x] **Step 2: Run and watch them pass**

Run: `npx vitest run app/api/tools/routes.test.ts`
Expected: PASS. **These tests should pass on the first run** — Tasks 2 to 4 built
what they assert. They are here because the acceptance criteria are written at
this level: through the real handler, on the real path, from the fixture Retell
actually sends. If any fails, the failure is real.

- [x] **Step 3: Say in the fixtures README why there is no failure fixture**

Append to `fixtures/retell/tools/README.md`:

```markdown
## The failed booking

There is no `book-slot-failure.json`, and there should not be. A `book_slot`
failure is forced by *state*, not by the payload: `appointments_no_overlap`
refuses the write because another Appointment already holds that Slot. The body
Retell sends is identical either way.

So `app/api/tools/routes.test.ts` seeds a competing Appointment onto a Slot that
`check_availability` just offered, then posts `book-slot.json` at it. That drives
SPEC.md §8 end to end — two attempts, a callback promise, and
`needs_attention_reason = 'book_failed'` — with no telephony spend.

`npm run try-tools` does the same thing over real HTTP against a real database.
```

- [x] **Step 4: Commit**

```bash
git add app/api/tools/routes.test.ts fixtures/retell/tools/README.md
git commit -m "Drive the negotiation and the failed booking through the real routes"
```

---

### Task 9: Prove the retry happens twice

SPEC.md §8 step 1 says "retry once, silently". Two identical constraint
violations are indistinguishable from one at the database, so this needs a spy.

**Files:**
- Create: `lib/tools/book-slot-retry.test.ts`

- [x] **Step 1: Write the failing test**

Create `lib/tools/book-slot-retry.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rescheduleAppointment } from "@/lib/appointments/reschedule";
import { db, schema } from "@/lib/db";
import { bookSlotTool } from "@/lib/tools/book-slot";
import { checkAvailability } from "@/lib/tools/check-availability";
import { resolveToolContext, type ToolContext } from "@/lib/tools/request";
import { runTool } from "@/lib/tools/run";
import { NOT_COMMITTED } from "@/lib/tools/say";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

/*
  SPEC.md §8 step 1: "Retry once, silently." Two attempts, not two retries, and
  one answer to the customer.

  This lives in its own file because `vi.mock` is hoisted to the top of whichever
  file it appears in. Putting it in book-slot.test.ts would replace the module
  for eleven tests that want the real one.

  The spy wraps the real function rather than replacing it, so every assertion
  about the database below is still about real behaviour. All this file adds is a
  count.
*/
vi.mock("@/lib/appointments/reschedule", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/appointments/reschedule")>();
  return { ...actual, rescheduleAppointment: vi.fn(actual.rescheduleAppointment) };
});

const CLERK_ID = "user_test_tools_book_retry";
const APPOINTMENT_STARTS_AT = new Date("2026-08-17T03:30:00.000Z");
const NOW = new Date("2026-08-17T02:30:00.000Z");
const HOUR_MS = 60 * 60_000;

let seed: ToolTestSeed;
let context: ToolContext;

const attempts = vi.mocked(rescheduleAppointment);

async function check(): Promise<{ slots: { slot_start: string; time: string }[] }> {
  return (await runTool({
    name: "check_availability",
    args: {},
    context,
    handler: checkAvailability,
    now: NOW,
  })) as { slots: { slot_start: string; time: string }[] };
}

async function book(slotStart: string) {
  return (await runTool({
    name: "book_slot",
    args: { slot_start: slotStart },
    context,
    handler: bookSlotTool,
    now: NOW,
  })) as { ok: boolean; reason?: string; say?: string };
}

async function occupy(slotStart: string) {
  await db.insert(schema.appointments).values({
    businessId: seed.businessId,
    serviceId: seed.serviceId,
    name: "Faster Caller",
    phoneE164: "+919876500002",
    startsAt: new Date(slotStart),
    endsAt: new Date(new Date(slotStart).getTime() + HOUR_MS),
    status: "confirmed",
  });
}

beforeEach(async () => {
  attempts.mockClear();
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: APPOINTMENT_STARTS_AT,
  });
  context = (await resolveToolContext(seed.retellCallId))!;
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
});

describe("SPEC.md §8's silent retry", () => {
  it("tries twice before giving up", async () => {
    const [first] = (await check()).slots;
    await occupy(first.slot_start);

    const result = await book(first.slot_start);

    expect(attempts).toHaveBeenCalledTimes(2);
    // One answer, not two. The retry is silent to the person on the phone.
    expect(result).toEqual({
      ok: false,
      reason: "slot_taken",
      say: NOT_COMMITTED.bookFailed,
    });
  });

  it("does not retry a booking that worked", async () => {
    const [first] = (await check()).slots;

    expect((await book(first.slot_start)).ok).toBe(true);
    expect(attempts).toHaveBeenCalledTimes(1);
  });

  it("does not reach the database at all for a time nobody offered", async () => {
    // The three cheap checks run first, in order. A hallucinated time never
    // becomes an attempted write.
    expect((await book("2026-08-17T07:30:00.000Z")).reason).toBe("not_offered");
    expect(attempts).not.toHaveBeenCalled();
  });

  it("leaves the Appointment where it was after both attempts fail", async () => {
    const [first] = (await check()).slots;
    await occupy(first.slot_start);
    await book(first.slot_start);

    const appointment = await db.query.appointments.findFirst({
      where: eq(schema.appointments.id, seed.appointmentId),
    });
    expect(appointment!.startsAt).toEqual(APPOINTMENT_STARTS_AT);
    expect(appointment!.needsAttentionReason).toBe("book_failed");
  });
});
```

- [x] **Step 2: Run it**

Run: `npx vitest run lib/tools/book-slot-retry.test.ts`
Expected: PASS — 4 tests. The behaviour already exists (`ATTEMPTS = 2` in
`lib/tools/book-slot.ts`); this file is what proves it.

**If `"tries twice"` reports 1 call**, the loop is not retrying — read
`lib/appointments/reschedule.ts`'s savepoint comment before changing anything,
because a transaction aborted by the first failure would make a second attempt
impossible.

- [x] **Step 3: Commit**

```bash
git add lib/tools/book-slot-retry.test.ts
git commit -m "Count the two attempts SPEC.md section 8 asks for"
```

---

### Task 10: The prompt gains two clauses

**Files:**
- Modify: `lib/retell/templates.ts`
- Modify: `lib/retell/templates.test.ts`

- [x] **Step 1: Write the failing test**

In `lib/retell/templates.test.ts`, find the describe block containing the
existing `expect(prompt).toContain("If book_slot fails")` assertions and add
these two tests beside them:

```ts
  it("tells her what to do when nothing is open", () => {
    // check_availability can return an empty list — a full fortnight, or a Call
    // that has worked through everything in it. Without a branch she improvises
    // one, and the improvised version invents a time.
    for (const template of TEMPLATES) {
      const prompt = buildPrompt(template);
      expect(prompt).toContain("no times at all");
      expect(prompt).toContain("someone will call them back");
    }
  });

  it("tells her to use the words a tool hands her", () => {
    // lib/tools/say.ts owns the sentence for every outcome that matters. This
    // line is the prompt-side half of that, and it is a suggestion — which is
    // why the response itself is unambiguous without it.
    for (const template of TEMPLATES) {
      expect(buildPrompt(template)).toContain("say");
    }
  });
```

- [x] **Step 2: Run and watch it fail**

Run: `npx vitest run lib/retell/templates.test.ts`
Expected: FAIL — `"tells her what to do when nothing is open"` cannot find the
strings. The second test may pass already (the word "say" appears in the prompt);
that is acceptable — the first is the one that matters.

- [x] **Step 3: Make the change**

In `lib/retell/templates.ts`, replace step 3 and the Rules paragraph inside
`buildPrompt`:

```ts
  return `You are Maya, a friendly scheduling assistant calling on behalf of {{business_name}}, a ${template.businessNoun}.
You are speaking with {{name}} about their {{service}} ${template.serviceNoun} on {{time}}.

Goal: confirm whether they can attend, and rebook them if they cannot.
1. Greet them by name, say why you're calling, ask if {{time}} still works.
2. If yes: call confirm_appointment, tell them it's locked in, end the call.
3. If no: call check_availability, offer the times it returns. If they reject them,
   ask what would suit and call check_availability again. Repeat until one works.
   Then call book_slot and read the booked time back to them. If check_availability
   returns no times at all, tell them so, say someone will call them back, and end
   the call.
4. If they want to cancel entirely: call cancel_appointment, acknowledge, end the call.
5. If it's clearly a wrong number or voicemail: apologise briefly and end the call.

Rules: keep every reply under 2 sentences. Only ever offer times that
check_availability returned — never invent one. When you call book_slot, pass
slot_start exactly as check_availability returned it. When a tool's answer
includes a say value, use those words. If book_slot fails, say you'll have
someone call back to confirm; never say the booking is done. Never discuss
anything except this appointment. Never invent personal details.
${template.inventionGuard}`;
```

Then extend the docstring above `buildPrompt`. After the existing two bullets,
add:

```
 * - the empty-Availability branch in step 3 — check_availability can return
 *   nothing, either because the fortnight is full or because this Call has
 *   already worked through it (lib/tools/check-availability.ts), and an
 *   unguided model fills that silence by inventing a time.
 * - "when a tool's answer includes a say value, use those words" — the
 *   prompt-side half of lib/tools/say.ts. It is a suggestion, which is exactly
 *   why the tool response is written to be unreadable as a success on its own.
```

- [x] **Step 4: Run and watch it pass**

Run: `npx vitest run lib/retell/templates.test.ts`
Expected: PASS.

Two existing assertions in that file are worth re-reading if anything else
breaks: the prompt must still contain no `\d+ seconds` and no "business hours",
because both are enforced in config and in the Tool rather than asked for
(SPEC.md §3 rule 6). The new text contains neither.

- [x] **Step 5: Run the whole suite and typecheck**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green.

- [x] **Step 6: Commit**

```bash
git add lib/retell/templates.ts lib/retell/templates.test.ts
git commit -m "Tell Maya what to do when nothing is open"
```

---

### Task 11: `scripts/try-tools.ts` drives the failure by hand

The tests call the route handlers directly, so they prove the handlers. This
script is the only thing that proves a request reaches them at all through
`proxy.ts` — and now, that the failure path does too.

**Files:**
- Modify: `scripts/try-tools.ts`

- [x] **Step 1: Add the forced-failure leg**

In `scripts/try-tools.ts`, inside the `try` block, replace step 6 (the
`book_slot` for a time nobody offered) and everything up to the
`"--- Without the secret, which must be 401 ---"` line with:

```ts
      // 6. A time nobody offered, which must also be refused.
      await callTool("book_slot", retellCallId, {
        slot_start: new Date(startsAt.getTime() + 3 * 86_400_000).toISOString(),
      });
    }

    /*
      SPEC.md §8, forced. The failure cannot come from the payload — the
      constraint refuses the write because another Appointment holds the Slot —
      so a competing Appointment is parked on an offered Slot first.

      This is the path that matters more than the happy one. Maya must promise a
      callback and must never claim the booking worked (SPEC.md §3 rule 7).
    */
    console.log("\n--- The booking that fails, which must not sound like success ---");

    const failureCallId = `${retellCallId}_failure`;
    const [failureCall] = await db
      .insert(schema.calls)
      .values({
        appointmentId: appointment.id,
        retellCallId: failureCallId,
        callType: "web",
        status: "in_progress",
      })
      .returning();

    const toLose = (await callTool("check_availability", failureCallId)) as {
      slots?: { slot_start: string; time: string }[];
    };

    if (toLose?.slots?.length) {
      const target = toLose.slots[0];

      const [competitor] = await db
        .insert(schema.appointments)
        .values({
          businessId: business.id,
          serviceId: service.id,
          name: MARKER,
          phoneE164: "+919999999998",
          startsAt: new Date(target.slot_start),
          endsAt: new Date(
            new Date(target.slot_start).getTime() + service.durationMinutes * 60_000,
          ),
          status: "confirmed",
        })
        .returning();

      console.log(`    (someone else just took ${target.time})`);

      const failed = (await callTool("book_slot", failureCallId, {
        slot_start: target.slot_start,
      })) as { ok?: boolean; say?: string; booked_time?: string };

      console.log(`    (Maya would say: "${failed.say ?? "—"}")`);

      if (failed.ok !== false) console.log("    ^ WRONG. This had to be ok:false.");
      if (failed.booked_time) console.log("    ^ WRONG. A failure named a booked time.");

      const flagged = await db.query.appointments.findFirst({
        where: eq(schema.appointments.id, appointment.id),
      });
      console.log(`    needs_attention_reason: ${flagged!.needsAttentionReason ?? "—"}`);

      await db.delete(schema.appointments).where(eq(schema.appointments.id, competitor.id));
    }

    await db.delete(schema.toolInvocations).where(eq(schema.toolInvocations.callId, failureCall.id));
    await db.delete(schema.calls).where(eq(schema.calls.id, failureCall.id));
```

**Note the second Call row.** The one-booking index is per Call, and the happy
path above already committed a Reschedule on `retellCallId` — a `book_slot` there
would be refused as `already_booked` and never reach the constraint at all. A
second Call is what makes this leg test the thing it claims to test.

- [x] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0. If `eq` or `schema` is reported missing, add it to
the existing imports at the top of the script.

- [x] **Step 3: Note that running it needs a live app**

This script cannot run in CI and is not part of `npm test`. It needs
`npm run dev` in one terminal and the Cloud SQL Auth Proxy up, as its own header
comment says. It is run by hand in Task 13.

- [x] **Step 4: Commit**

```bash
git add scripts/try-tools.ts
git commit -m "Let try-tools drive the failed booking too"
```

---

### Task 12: ADR-0012

**Files:**
- Create: `docs/adr/0012-the-tool-supplies-the-sentence.md`

- [x] **Step 1: Read a neighbour for the house format**

Read `docs/adr/0011-tools-prove-an-offer-by-replaying-tool-invocations.md`. Match
its headings and its length. Every ADR in this repo records what was rejected and
why, not just what was chosen.

- [x] **Step 2: Write it**

Create `docs/adr/0012-the-tool-supplies-the-sentence.md` covering:

- **Context.** SPEC.md §3 rule 7 is the most damaging failure available to this
  product. Before this change it was defended by one line of prompt, and SPEC.md
  §3 rule 6 already says a prompt instruction is a suggestion.
- **Decision.** Every Tool result carries a `say`. The lines live in
  `lib/tools/say.ts` in two groups, and a test holds the failure group to
  containing no success language.
- **Rejected: leaving it to the prompt.** Same argument as Business Hours.
- **Rejected: Retell `response_variables`.** Same outcome, plus a
  re-provisioning step and a second home for the wording.
- **Consequence, stated honestly.** `say` is a strong steer, not a guarantee —
  `speak_after_execution` has the model generate speech from the response, so it
  may paraphrase. What it cannot do is read a response whose every field says
  this did not work and conclude that it did.
- **Second decision: truncation is one pure function.**
  `wasNegotiationTruncated` is called by `recordCallEnded` now and by #13's
  webhook later. Rejected: letting the browser report it, and waiting for #13.
- **Known limitation.** On the Web Call path truncation is inferred from
  duration, so a person who hangs up at 116 seconds with nothing agreed is
  recorded the same as one cut off by the cap. Both want a human to call back, so
  the wrong answer costs a row in a queue rather than a wrong action.

- [x] **Step 3: Commit**

```bash
git add docs/adr/0012-the-tool-supplies-the-sentence.md
git commit -m "Record why the Tool owns the sentence, not the prompt"
```

---

### Task 13: Re-provision the Agents and place one live Call

**Manual. This is the only step in the plan that spends money (~$0.15), and the
only one that cannot be done by an agent.** SPEC.md §3 rule 11: real Calls only
via explicit manual user action.

**Files:**
- Modify: `docs/verification.md`

- [x] **Step 1: Confirm the suite is green first**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all green. **Do not place a Call against a red tree.**

- [x] **Step 2: Push the new prompt to Retell**

Run: `npm run create-agents`
Expected: it reconciles on agent name and updates the four existing Agents rather
than creating four more (ADR-0006). If it reports finding two Agents with the
same name it exits non-zero rather than guessing — resolve that in the Retell
dashboard before continuing.

- [x] **Step 3: Check the Tool endpoints are reachable over real HTTP**

With `npm run dev` running in another terminal and the Cloud SQL Auth Proxy up:

Run: `npm run try-tools`
Expected: every Tool returns 200; the negotiation prints two rounds with
*different* times; the second `book_slot` is refused as `already_booked`; the
forced-failure leg prints Maya's callback line and
`needs_attention_reason: book_failed`. A 307 or 302 means `/api/tools` is missing
from `isPublicRoute` in `proxy.ts`.

- [x] **Step 4: Place the Call**

On the Overview screen, press "Call now" on the Quick Call card. Then:

1. Say the time does not work.
2. Refuse the first set of times she offers.
3. Accept one from the second set.
4. **Before hanging up**, look at the dashboard row. It should already show the
   new time and a `rescheduled` pill.

- [x] **Step 5: Write down what the live Call settled**

In `docs/verification.md`, update two items with today's date:

- **A12**, the `Authorization` header. Read the `tool_invocations` rows for that
  Call: if they exist, the header arrived in some accepted form. Record whether
  Retell forwarded `Authorization` or whether `X-Callzie-Secret` was the one that
  worked, and delete "UNVERIFIED".
- **A4/A12**, draft versus published Agents. If Maya used the new
  empty-Availability branch and the `say` wording, `create-web-call` runs the
  draft and `scripts/create-agent.ts` is correct not to publish. If she used the
  old prompt, it runs the published version — add one `client.agent.publish` per
  Agent to the script and re-run it.

- [x] **Step 6: Commit**

```bash
git add docs/verification.md
git commit -m "Answer A4 and A12 from the first live Tool invocation"
```

---

## Definition of done

Every box above is ticked, and:

- [x] `npm test` is green
- [x] `npm run typecheck` is green
- [x] `npm run lint` is green
- [x] A multi-round negotiation moves the Appointment and the dashboard row
      changes before the Call ends (Task 13 step 4)
- [x] `book_slot` cannot be given a time `check_availability` did not return
      (`routes.test.ts`, `book-slot.test.ts`)
- [x] Cancelling frees the Slot and confirming holds it
      (`confirm-cancel.test.ts`, `routes.test.ts`)
- [x] A forced `book_slot` failure produces two attempts, a callback promise, a
      `book_failed` Appointment, and no success claim (Tasks 8 and 9)
- [x] A Call that ran to the cap with nothing committed lands in Needs Attention
      and is not recorded as a booking (Task 7)
- [x] The whole failure path runs from a fixture with no spend (Task 8) and by
      hand with `npm run try-tools` (Task 11)
