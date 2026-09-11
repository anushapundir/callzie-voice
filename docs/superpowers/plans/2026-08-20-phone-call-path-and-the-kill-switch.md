# Phone Call path and the kill switch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A flagged account's "Call now" rings a real phone; an unflagged account cannot place a Phone Call by any route, including a crafted request.

**Architecture:** The route and the permission check are the same database read — `startCall` selects `phone_calls_enabled` alongside the Appointment and picks the route from it, so `createPhoneCall` is reachable from exactly one branch whose condition is the flag. Two phone-only refusals (no `RETELL_FROM_NUMBER`, a seeded fictional destination) sit above the Quota claim, so a refused Phone Call costs nothing. Everything downstream is shared: same metadata, same compensating write, same `calls` row apart from `call_type`.

**Tech Stack:** Next.js 16 App Router, TypeScript, Drizzle + Postgres, `retell-sdk` (server), Vitest against a local embedded Postgres.

**Spec:** `docs/superpowers/specs/2026-08-20-phone-call-path-and-the-kill-switch-design.md`

---

## File structure

**New**

| File | Responsibility |
|---|---|
| `lib/calls/destination.ts` | Whether a stored number may be dialled. Pure. |
| `lib/calls/destination.test.ts` | Its cases. No database. |
| `lib/settings/phone-calls.ts` | The admin-scoped flag write. |
| `lib/settings/phone-calls.test.ts` | Non-admin writes nothing; wrong Business writes nothing. |
| `components/settings/phone-calls-section.tsx` | The admin-only switch and what blocks it. |
| `docs/runbooks/phone-call-preflight.md` | The human sequence: KYC → number → India → one real Call. |
| `docs/adr/0012-phone-route-chosen-by-the-flag.md` | Why selection and permission are one read. |

**Renamed**

| From | To |
|---|---|
| `lib/calls/start-web-call.ts` | `lib/calls/start-call.ts` |
| `lib/calls/start-web-call.test.ts` | `lib/calls/start-call.test.ts` |

**Modified**

| File | Change |
|---|---|
| `lib/calls/start-call.ts` | Route selection, phone branch, two refusals, `PhoneCallCreator` |
| `lib/calls/machine.ts` | `dialling` state, `START_PHONE` and `DIALLING` events, `isDismissable` |
| `app/(app)/calls/actions.ts` | `startWebCallAction` → `startCallAction`, returns `callType` |
| `app/(app)/layout.tsx` | Passes `phoneCallsEnabled` into the provider |
| `components/calls/live-call-provider.tsx` | Skips mic and SDK on the phone route |
| `components/calls/live-call-bar.tsx` | Renders `dialling` |
| `app/(app)/settings/actions.ts` | `setPhoneCallsEnabledAction` |
| `app/(app)/settings/page.tsx` | Renders the new section inside the `is_admin` block |
| `.env.example` | `RETELL_FROM_NUMBER` is now read by a live path |

**Naming, fixed now so later tasks agree:** the orchestrator is `startCall`, its result type is `StartCallResult`, the injected creators are `createWebCall` / `createPhoneCall` typed `WebCallCreator` / `PhoneCallCreator`, the destination check is `checkDestination`, the flag write is `setPhoneCallsEnabled`, and its action is `setPhoneCallsEnabledAction`.

---

### Task 0: Green baseline

Nothing below can be trusted on a red baseline. If the suite is already failing, stop and report rather than building on it.

**Files:** none

- [ ] **Step 1: Install, if `node_modules/` is absent**

```bash
npm install
```

- [ ] **Step 2: Confirm the suite is green**

Run: `npm test`
Expected: all tests pass. If any fail, stop and report — do not continue.

- [ ] **Step 3: Confirm types and lint are green**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

---

### Task 1: `checkDestination` — whether a stored number may be dialled

Pure, no database, no Retell. Two refusals with two different messages, because "that is not a phone number" and "that is a demo number" need different answers.

The fictional range matters. Every seeded Appointment carries a number in `+1 202 555 01xx` — see `lib/onboarding/templates.ts`, whose comment already names #19 as the ticket that points a real dialler at those rows. Dialling one spends roughly $0.50 of an $8 budget on a call that cannot connect.

**Files:**
- Create: `lib/calls/destination.ts`
- Test: `lib/calls/destination.test.ts`

> ⚠️ **The code below is what was planned, not what shipped.** Three things
> changed under review, so re-running these snippets verbatim now fails — read
> a failure here as drift in this document, not a regression in the code. The
> shipped version is `lib/calls/destination.ts`.
>
> 1. `checkDestination` returns `{ ok: true, number }`, not bare `{ ok: true }`.
>    The caller must dial `number`. The plan dialled the raw column, which meant
>    the number that was validated and the number that was dialled were not the
>    same string — `+1 (202) 555-0110` would have passed the normalised check and
>    then been dialled.
> 2. The pattern is `/^\+1\d{3}55501\d{2}$/`, covering `555-01xx` in every NANP
>    area code rather than only the 202 the seed uses.
> 3. The format refusal carries its own dashboard wording, not `parseE164`'s
>    form-field copy. "Enter a phone number." makes no sense under a Call now
>    button with no field on screen.
>
> The shipped file has 9 tests, not the 6 below.

- [ ] **Step 1: Write the failing test**

Create `lib/calls/destination.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { checkDestination } from "./destination";

/*
  Whether a number in `appointments.phone_e164` may be dialled.

  Pure and offline. The fictional-range case is the one worth having: seeded
  Appointments all carry one, so it is the first number a flagged account will
  press "Call now" on, and Retell would bill for the failure.
*/

describe("checkDestination", () => {
  it("accepts a real E.164 number", () => {
    expect(checkDestination("+919876543210")).toEqual({ ok: true });
  });

  it("accepts a real US number outside the fictional range", () => {
    expect(checkDestination("+12025551234")).toEqual({ ok: true });
  });

  it("refuses a seeded number from the reserved fictional range", () => {
    const result = checkDestination("+12025550110");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("demo number");
  });

  it("refuses every number the seed templates use", () => {
    // The whole +1 202 555 01xx block, not just the two the seed happens to
    // pick today. A template gaining an appointment must not open a hole.
    for (let last = 0; last < 100; last += 1) {
      const number = `+120255501${String(last).padStart(2, "0")}`;
      expect(checkDestination(number).ok, number).toBe(false);
    }
  });

  it("refuses a number that is not E.164", () => {
    const result = checkDestination("2025551234");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("country code");
  });

  it("refuses an empty number", () => {
    expect(checkDestination("").ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/calls/destination.test.ts`
Expected: FAIL — `Failed to resolve import "./destination"`.

- [ ] **Step 3: Write the implementation**

Create `lib/calls/destination.ts`:

```ts
import { parseE164 } from "@/lib/appointments/phone";

/*
  Whether a stored number may be dialled by a Phone Call (issue #19).

  This runs on the Phone Call path only, above the Quota claim, so a refusal
  costs the account nothing. Two separate reasons, because they have different
  answers: a malformed number is a data problem, and a fictional one means you
  are about to demo against the seed.
*/

/**
 * The reserved fictional block every seeded Appointment uses.
 *
 * `lib/onboarding/templates.ts` picks numbers from `+1 202 555 01xx` precisely
 * so a real dialler pointed at the seed reaches nobody. That protects the
 * stranger; it does not protect the budget. A Phone Call to one of these still
 * bills — roughly $0.50 of an ~$8 line (docs/verification.md A2) — and then
 * fails in what was meant to be a demo rehearsal. So it is refused here, with a
 * message that says what to do instead.
 *
 * The pattern matches `lib/onboarding/templates.test.ts`, which asserts every
 * template appointment falls inside it. The two must stay in step: widening the
 * seed without widening this would let a seeded number through.
 */
const RESERVED_FICTIONAL = /^\+120255501\d{2}$/;

export type DestinationCheck =
  | { ok: true }
  | { ok: false; message: string };

/**
 * Whether this number may be dialled.
 *
 * Reuses `parseE164` rather than re-checking the format, so there is one
 * definition of a well-formed number in the codebase. Every write path already
 * runs it — quick-add, CSV upload — which makes the format branch here belt and
 * braces rather than the point. The point is the range below it.
 */
export function checkDestination(phoneE164: string): DestinationCheck {
  const parsed = parseE164(phoneE164);
  if (!parsed.ok) return { ok: false, message: parsed.error };

  if (RESERVED_FICTIONAL.test(parsed.value)) {
    return {
      ok: false,
      message:
        "That's a demo number. Add an appointment with a real number first.",
    };
  }

  return { ok: true };
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run lib/calls/destination.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/calls/destination.ts lib/calls/destination.test.ts
git commit -m "Refuse to dial the seeded fictional numbers

The +1 202 555 01xx block protects the stranger, not the budget. A flagged
account pressing Call now on a seeded row bills for a call that cannot
connect. Refusing costs one comparison.

Issue #19."
```

---

### Task 2: `startCall` — the route and the guard are one read

The heart of the ticket. `startWebCall` becomes `startCall`, chooses its route from the same scoped read that fetches the Appointment, and grows a phone branch.

**Files:**
- Rename: `lib/calls/start-web-call.ts` → `lib/calls/start-call.ts`
- Rename: `lib/calls/start-web-call.test.ts` → `lib/calls/start-call.test.ts`

- [ ] **Step 1: Rename both files with git, so history follows**

```bash
git mv lib/calls/start-web-call.ts lib/calls/start-call.ts
git mv lib/calls/start-web-call.test.ts lib/calls/start-call.test.ts
```

- [ ] **Step 2: Point the existing test file at the new name**

In `lib/calls/start-call.test.ts`, change the import and every call site:

```ts
import { startCall, type WebCallCreator } from "@/lib/calls/start-call";
```

Replace every `startWebCall({` with `startCall({`, and the `describe("startWebCall"` header with `describe("startCall"`.

Also update the one caller so the tree still compiles — in `app/(app)/calls/actions.ts`:

```ts
import { startCall } from "@/lib/calls/start-call";
```

and inside `startWebCallAction`, `const result = await startCall({ businessId: business.id, appointmentId });`

- [ ] **Step 3: Rename the export in the implementation**

In `lib/calls/start-call.ts`, rename `startWebCall` to `startCall` and `StartWebCallResult` to `StartCallResult`. Change nothing else yet.

- [ ] **Step 4: Confirm the rename is inert**

Run: `npx vitest run lib/calls/start-call.test.ts && npm run typecheck`
Expected: PASS, same count as before. A rename that changes behaviour is a bug.

- [ ] **Step 5: Commit the rename on its own**

```bash
git add -A
git commit -m "Rename startWebCall to startCall ahead of the phone route

Pure rename, no behaviour change, committed separately so the phone diff
is readable.

Issue #19."
```

- [ ] **Step 6: Write the failing phone tests**

Append to `lib/calls/start-call.test.ts`. First, the fakes and helpers — add these beside the existing `fakeCreator`:

```ts
import { formatForSpeech } from "@/lib/time/zone";
import {
  startCall,
  type PhoneCallCreator,
  type WebCallCreator,
} from "@/lib/calls/start-call";

/*
  A Retell phone dialler that always succeeds, and records what it was asked
  for. Fresh `call_id` per response for the same reason as the web fake:
  `calls.retell_call_id` is UNIQUE.
*/
function fakePhoneCreator() {
  const calls: {
    from_number: string;
    to_number: string;
    override_agent_id: string;
    retell_llm_dynamic_variables: Record<string, string>;
    metadata: Record<string, string>;
  }[] = [];

  const creator: PhoneCallCreator = async (params) => {
    calls.push(params);
    nextRetellCallId += 1;
    return { call_id: `retell-call-${nextRetellCallId}` };
  };

  return Object.assign(creator, { calls });
}

/** A phone dialler that is down. */
const throwingPhoneCreator: PhoneCallCreator = async () => {
  throw new Error("503 from Retell");
};

/** Turns the flag on for the Business under test. */
async function enablePhoneCalls() {
  await db
    .update(schema.businesses)
    .set({ phoneCallsEnabled: true })
    .where(eq(schema.businesses.id, businessId));
}

/** Gives the Appointment under test a real, dialable number. */
async function setRealNumber(phoneE164 = "+919876543210") {
  await db
    .update(schema.appointments)
    .set({ phoneE164 })
    .where(eq(schema.appointments.id, appointmentId));
}
```

`RETELL_FROM_NUMBER` is read from the environment, so the phone block sets and restores it around itself:

```ts
describe("startCall on the phone route", () => {
  const ORIGINAL_FROM_NUMBER = process.env.RETELL_FROM_NUMBER;

  beforeEach(() => {
    process.env.RETELL_FROM_NUMBER = "+14157774444";
  });

  afterEach(() => {
    if (ORIGINAL_FROM_NUMBER === undefined) {
      delete process.env.RETELL_FROM_NUMBER;
    } else {
      process.env.RETELL_FROM_NUMBER = ORIGINAL_FROM_NUMBER;
    }
  });

  it("never dials for an account without the flag", async () => {
    await setRealNumber();
    const dialler = fakePhoneCreator();

    const result = await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: dialler,
    });

    // The acceptance criterion, as an assertion: the flag is off, so the
    // dialler is not merely refused — it is never reached.
    expect(dialler.calls).toHaveLength(0);
    expect(result.ok && result.callType).toBe("web");
  });

  it("dials the Appointment's number for a flagged account", async () => {
    await enablePhoneCalls();
    await setRealNumber("+919876543210");
    const dialler = fakePhoneCreator();

    const result = await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: dialler,
    });

    expect(result.ok && result.callType).toBe("phone");
    expect(dialler.calls).toHaveLength(1);
    expect(dialler.calls[0].from_number).toBe("+14157774444");
    expect(dialler.calls[0].to_number).toBe("+919876543210");
    // Not `agent_id` — create-phone-call names it differently
    // (docs/verification.md A6).
    expect(dialler.calls[0].override_agent_id).toBe("agent_test_clinic");
  });

  it("sends Maya the same name and time as a Web Call", async () => {
    await enablePhoneCalls();
    await setRealNumber();
    const dialler = fakePhoneCreator();

    await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: dialler,
    });

    const variables = dialler.calls[0].retell_llm_dynamic_variables;
    expect(variables.name).toBe("Priya Nair");
    expect(variables.business_name).toBe("Bandra Dental");
    expect(variables.service).toBe("Cleaning");
    /*
      Speakable, not the dashboard's abbreviated 24-hour rendering — the two
      formats have opposite goals (lib/time/zone.ts). Asserted against
      `formatForSpeech` itself rather than a literal, so this test pins that the
      phone route uses the same formatter as the web route rather than pinning
      one particular wording of 9am in Asia/Kolkata.
    */
    expect(variables.time).toBe(formatForSpeech(STARTS_AT, "Asia/Kolkata"));
  });

  it("echoes the same metadata a Web Call sends, so #13 needs no branch", async () => {
    await enablePhoneCalls();
    await setRealNumber();
    const dialler = fakePhoneCreator();

    await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: dialler,
    });

    const [call] = await callRows();
    expect(dialler.calls[0].metadata).toEqual({
      call_id: call.id,
      appointment_id: appointmentId,
    });
  });

  it("writes a Call row identical to a Web Call's apart from call_type", async () => {
    await enablePhoneCalls();
    await setRealNumber();

    await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: fakePhoneCreator(),
    });

    const [call] = await callRows();
    expect(call.callType).toBe("phone");
    expect(call.attempt).toBe(1);
    expect(call.status).toBe("queued");
    expect(call.retellCallId).toMatch(/^retell-call-\d+$/);
    expect(await callsUsed()).toBe(1);
    expect(await appointmentStatus()).toBe("calling");
  });

  it("refuses, and spends nothing, when RETELL_FROM_NUMBER is blank", async () => {
    delete process.env.RETELL_FROM_NUMBER;
    await enablePhoneCalls();
    await setRealNumber();
    const dialler = fakePhoneCreator();

    const result = await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: dialler,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("phone_not_configured");
    // The ordering, not just the refusal: the check must sit above the claim.
    expect(dialler.calls).toHaveLength(0);
    expect(await callsUsed()).toBe(0);
    expect(await callRows()).toHaveLength(0);
  });

  it("refuses, and spends nothing, on a seeded fictional number", async () => {
    await enablePhoneCalls();
    // The seed's own number — left as `seedBusiness` wrote it.
    const dialler = fakePhoneCreator();

    const result = await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: dialler,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("phone_number_unusable");
    expect(dialler.calls).toHaveLength(0);
    expect(await callsUsed()).toBe(0);
    expect(await callRows()).toHaveLength(0);
  });

  it("hands the Call back when Retell fails, exactly as the Web Call does", async () => {
    await enablePhoneCalls();
    await setRealNumber();

    const result = await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: throwingPhoneCreator,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("retell_failed");

    const [call] = await callRows();
    expect(call.status).toBe("failed");
    expect(call.disconnectReason).toBe("create_phone_call_failed");
    expect(await callsUsed()).toBe(0);
  });

  it("cannot dial another Business's Appointment", async () => {
    await enablePhoneCalls();
    const dialler = fakePhoneCreator();

    const result = await startCall({
      businessId,
      appointmentId: otherAppointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: dialler,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("not_found");
    expect(dialler.calls).toHaveLength(0);
  });
});
```

- [ ] **Step 7: Run it and watch it fail**

Run: `npx vitest run lib/calls/start-call.test.ts`
Expected: FAIL — `PhoneCallCreator` is not exported, and `result.callType` does not exist.

- [ ] **Step 8: Add the phone creator type and the real one**

In `lib/calls/start-call.ts`, below `createWebCallWithRetell`:

```ts
/**
 * The other half of Retell, as a function.
 *
 * Injected for the same reason `WebCallCreator` is: every branch, including the
 * compensating write, runs in tests that contact nobody (SPEC.md §3 rule 11).
 *
 * Note `override_agent_id` rather than `agent_id`. create-phone-call really does
 * name it differently from create-web-call (docs/verification.md A6), and
 * getting it wrong reaches a customer speaking the wrong Template's persona.
 */
export type PhoneCallCreator = (params: {
  from_number: string;
  to_number: string;
  override_agent_id: string;
  retell_llm_dynamic_variables: DynamicVariables;
  metadata: Record<string, string>;
}) => Promise<{ call_id: string }>;

/** The real one. */
export const createPhoneCallWithRetell: PhoneCallCreator = async (params) => {
  const response = await retellClient().call.createPhoneCall(params);
  return { call_id: response.call_id };
};
```

- [ ] **Step 9: Widen the result type and the messages**

Replace `StartCallResult` and add the two messages:

```ts
export type StartCallResult =
  | { ok: true; callType: "web"; callId: string; accessToken: string }
  | { ok: true; callType: "phone"; callId: string; toNumber: string }
  | {
      ok: false;
      reason:
        | "not_found"
        | "exhausted"
        | "invalid_variables"
        | "retell_failed"
        | "phone_not_configured"
        | "phone_number_unusable";
      message: string;
    };
```

In `MESSAGES`, add:

```ts
  phone_not_configured:
    "No phone number is configured for outbound calls. Set RETELL_FROM_NUMBER " +
    "on this deployment.",
  // `phone_number_unusable` has no entry: checkDestination writes its own
  // message, because "that is a demo number" and "that is not a phone number"
  // need different answers.
```

- [ ] **Step 10: Widen the signature and the scoped read**

Change the parameter list to accept both creators:

```ts
export async function startCall({
  businessId,
  appointmentId,
  createWebCall = createWebCallWithRetell,
  createPhoneCall = createPhoneCallWithRetell,
}: {
  businessId: string;
  appointmentId: string;
  createWebCall?: WebCallCreator;
  createPhoneCall?: PhoneCallCreator;
}): Promise<StartCallResult> {
```

Add two columns to the existing `db.select({ … })`, leaving the joins and the `WHERE` exactly as they are:

```ts
      phoneCallsEnabled: schema.businesses.phoneCallsEnabled,
      phoneE164: schema.appointments.phoneE164,
```

- [ ] **Step 11: Choose the route from that read, and refuse above the claim**

Immediately after the `if (!row)` block, before the dynamic variables:

```ts
  /*
    The route and the permission check are the same read — this is the guard
    SPEC.md §3 rule 9 asks for, and the reason it is not written as one.

    There is no `if (!enabled) refuse` anywhere, because there is nothing to
    refuse: an unflagged account does not reach a branch that could dial. It
    gets a Web Call. `createPhoneCall` below is reachable from exactly one
    branch, and the condition on that branch is the flag.

    Same argument as `claimCallQuota` and `appointments_no_overlap`: put the
    guarantee where it cannot be routed around, not where it has to be
    remembered. See ADR-0012.
  */
  const route: "web" | "phone" = row.phoneCallsEnabled ? "phone" : "web";
```

Then, after `validateDynamicVariables` and **before** `agentIdFor`:

```ts
  /*
    Both phone-only refusals sit above the Quota claim, so a Phone Call that
    cannot be placed has cost nothing. The tests assert that ordering rather
    than only the refusal — a guard below the claim would still return the right
    answer while quietly spending a Call.
  */
  if (route === "phone") {
    const fromNumber = process.env.RETELL_FROM_NUMBER?.trim();
    if (!fromNumber) {
      return {
        ok: false,
        reason: "phone_not_configured",
        message: MESSAGES.phone_not_configured,
      };
    }

    const destination = checkDestination(row.phoneE164);
    if (!destination.ok) {
      return {
        ok: false,
        reason: "phone_number_unusable",
        message: destination.message,
      };
    }
  }
```

Add the import at the top:

```ts
import { checkDestination } from "@/lib/calls/destination";
```

- [ ] **Step 12: Record the route on the Call row**

In the transaction's insert, replace `callType: "web"` with `callType: route`.

- [ ] **Step 13: Branch once, at the Retell call**

Replace the body of the `try` that contacts Retell. Everything around it — the compensating `catch`, the `retellCallId` write, the Appointment status write — stays shared:

```ts
  try {
    // The one genuine branch. Different endpoint, different parameter names,
    // different return. Everything above and below is shared.
    const metadata = { call_id: callId, appointment_id: appointmentId };

    let retellCallId: string;
    let accessToken: string | null = null;

    if (route === "phone") {
      const response = await createPhoneCall({
        // Non-null: refused above if blank, and nothing between here and there
        // can unset it.
        from_number: process.env.RETELL_FROM_NUMBER!.trim(),
        to_number: row.phoneE164,
        override_agent_id: agentId,
        retell_llm_dynamic_variables: variables,
        metadata,
      });
      retellCallId = response.call_id;
    } else {
      const response = await createWebCall({
        agent_id: agentId,
        retell_llm_dynamic_variables: variables,
        metadata,
      });
      retellCallId = response.call_id;
      accessToken = response.access_token;
    }

    await db
      .update(schema.calls)
      .set({ retellCallId })
      .where(eq(schema.calls.id, callId));

    await db
      .update(schema.appointments)
      .set({ status: "calling" })
      .where(eq(schema.appointments.id, appointmentId));

    return route === "phone"
      ? { ok: true, callType: "phone", callId, toNumber: row.phoneE164 }
      : { ok: true, callType: "web", callId, accessToken: accessToken! };
  } catch {
    await db
      .update(schema.calls)
      .set({
        status: "failed",
        disconnectReason: `create_${route}_call_failed`,
      })
      .where(eq(schema.calls.id, callId));
    await releaseCallQuota(db, businessId);

    return {
      ok: false,
      reason: "retell_failed",
      message: MESSAGES.retell_failed,
    };
  }
```

- [ ] **Step 14: Update the file's header comment**

Replace the paragraph that begins "This path places Web Calls and only Web Calls" with:

```
  This path places both kinds of Call, and which one is not a parameter. The
  scoped read above fetches `phone_calls_enabled` alongside the Appointment, and
  the route is that column — so there is no code path to `createPhoneCall` that
  did not go through the flag. SPEC.md §3 rule 9 and §14 rule 6, enforced
  structurally rather than by a check somebody has to remember. See ADR-0012.
```

- [ ] **Step 15: Fix the two existing assertions the widened result breaks**

The existing test `"returns the access token the browser needs to join"` reads `result.ok && result.accessToken`. TypeScript now narrows that to a union, so add the discriminant:

```ts
    expect(result.ok && result.callType === "web" && result.accessToken).toMatch(
      /^token-\d+$/,
    );
```

And in `app/(app)/calls/actions.ts`, `startWebCallAction` currently returns `result.accessToken` — Task 3 rewrites it. For now, narrow it so the tree compiles:

```ts
  if (!result.ok) return { ok: false, message: result.message };
  if (result.callType !== "web") return { ok: false, message: "Unexpected route." };
  return { ok: true, callId: result.callId, accessToken: result.accessToken };
```

- [ ] **Step 16: Run the tests and watch them pass**

Run: `npx vitest run lib/calls/start-call.test.ts && npm run typecheck`
Expected: PASS — the original cases plus 9 new phone cases.

- [ ] **Step 17: Commit**

```bash
git add -A
git commit -m "Make the flag choose the route, so it cannot be bypassed

createPhoneCall is reachable from exactly one branch, and the condition on
that branch is phone_calls_enabled, read in the same scoped query that
fetched the Appointment. There is no guard to forget to call.

Both phone-only refusals sit above the quota claim, so a Phone Call that
cannot be placed costs nothing. The tests assert that ordering, not just
the refusal.

Issue #19."
```

---

### Task 3: `startCallAction` — one action, no route parameter

The action must not take a route. If it did, a crafted POST could ask for one.

**Files:**
- Modify: `app/(app)/calls/actions.ts`

- [ ] **Step 1: Replace the action**

Rename `startWebCallAction` to `startCallAction` and widen its return:

```ts
export type StartCallState =
  | { ok: true; callType: "web"; callId: string; accessToken: string }
  | { ok: true; callType: "phone"; callId: string; toNumber: string }
  | { ok: false; message: string };

/**
 * Places a Call for one Appointment — which kind is not this function's
 * decision, and deliberately not the caller's either.
 *
 * There is one argument, and it is an Appointment id. A Server Action is a POST
 * anybody can send, so a `route` parameter here would be exactly the thing
 * SPEC.md §3 rule 9 forbids: a way to ask for a Phone Call. `startCall` reads
 * `phone_calls_enabled` for the sender's own Business and decides. A crafted
 * request reaches this same function and gets a Web Call.
 */
export async function startCallAction(
  appointmentId: string,
): Promise<StartCallState> {
  const { business } = await requireBusiness();

  const result = await startCall({ businessId: business.id, appointmentId });

  // The Quota meter and the row's status have both moved.
  revalidatePath("/");

  if (!result.ok) return { ok: false, message: result.message };
  return result.callType === "web"
    ? {
        ok: true,
        callType: "web",
        callId: result.callId,
        accessToken: result.accessToken,
      }
    : {
        ok: true,
        callType: "phone",
        callId: result.callId,
        toNumber: result.toNumber,
      };
}
```

- [ ] **Step 2: Update the file's header comment**

In the paragraph that begins "On trusting the browser at all", append:

```
  A Phone Call reports none of this. There is no browser on the line, so the
  three reporters below are never called for one and its row stays `calling`
  until #13's webhook exists. That is the correct answer rather than a gap: the
  only honest source for a Phone Call's outcome is Retell.
```

- [ ] **Step 3: Point the provider at the new name so the build passes**

In `components/calls/live-call-provider.tsx`, change the import from `startWebCallAction` to `startCallAction` and the one call site with it. The route handling comes in Task 5.

- [ ] **Step 4: Confirm the tree compiles**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Give the Call action one argument, and it is not the route

A route parameter on a Server Action is a way to ask for a Phone Call, which
is the thing rule 9 forbids. The action takes an Appointment id; startCall
reads the sender's own flag.

Issue #19."
```

---

### Task 4: The `dialling` state

A Phone Call has no browser lifecycle. The machine gets one state that reflects that honestly, rather than pretending to know things it cannot.

**Files:**
- Modify: `lib/calls/machine.ts`
- Test: `lib/calls/machine.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `lib/calls/machine.test.ts`:

```ts
describe("the phone route", () => {
  const TARGET = { appointmentId: "appointment-1", name: "Priya Nair" };

  it("skips the microphone and goes straight to placing", () => {
    const state = reduceCall(IDLE, { type: "START_PHONE", target: TARGET });

    expect(state.name).toBe("placing");
  });

  it("will not start a phone Call over a Call already in flight", () => {
    const live = reduceCall(IDLE, { type: "START_PHONE", target: TARGET });

    expect(
      reduceCall(live, { type: "START_PHONE", target: TARGET }),
    ).toBe(live);
  });

  it("reaches dialling once the Call is placed", () => {
    const placing = reduceCall(IDLE, { type: "START_PHONE", target: TARGET });
    const state = reduceCall(placing, {
      type: "DIALLING",
      callId: "call-1",
      toNumber: "+919876543210",
    });

    expect(state).toEqual({
      name: "dialling",
      target: TARGET,
      callId: "call-1",
      toNumber: "+919876543210",
    });
  });

  it("refuses a phone Call the same way as a web one", () => {
    const placing = reduceCall(IDLE, { type: "START_PHONE", target: TARGET });
    const state = reduceCall(placing, {
      type: "REFUSED",
      message: "That's a demo number.",
    });

    expect(state.name).toBe("refused");
  });

  it("ignores every SDK event, because none can arrive", () => {
    const placing = reduceCall(IDLE, { type: "START_PHONE", target: TARGET });
    const dialling = reduceCall(placing, {
      type: "DIALLING",
      callId: "call-1",
      toNumber: "+919876543210",
    });

    expect(reduceCall(dialling, { type: "SDK_CALL_STARTED", at: 1 })).toBe(
      dialling,
    );
    expect(reduceCall(dialling, { type: "SDK_CALL_ENDED" })).toBe(dialling);
    expect(reduceCall(dialling, { type: "DEADLINE_PASSED" })).toBe(dialling);
  });

  it("blocks a second Call while the phone is ringing", () => {
    const placing = reduceCall(IDLE, { type: "START_PHONE", target: TARGET });
    const dialling = reduceCall(placing, {
      type: "DIALLING",
      callId: "call-1",
      toNumber: "+919876543210",
    });

    expect(isSettled(dialling)).toBe(false);
    expect(reduceCall(dialling, { type: "START", target: TARGET })).toBe(
      dialling,
    );
  });

  it("can still be dismissed, because nothing else will ever end it", () => {
    const placing = reduceCall(IDLE, { type: "START_PHONE", target: TARGET });
    const dialling = reduceCall(placing, {
      type: "DIALLING",
      callId: "call-1",
      toNumber: "+919876543210",
    });

    expect(isDismissable(dialling)).toBe(true);
    expect(reduceCall(dialling, { type: "DISMISS" })).toEqual(IDLE);
  });
});
```

Add `isDismissable` to that file's import from `./machine`.

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run lib/calls/machine.test.ts`
Expected: FAIL — `isDismissable` is not exported and `START_PHONE` is not a known event.

- [ ] **Step 3: Add the state and the two events**

In `lib/calls/machine.ts`, add to `CallState`:

```ts
  /**
   * A Phone Call is ringing, and the browser will never learn more than that.
   *
   * No `live`, no `ended`, and that is not an omission. There is no SDK on this
   * route and nobody at the far end reporting to us, so any transition out of
   * here would be the browser claiming to know something only Retell knows.
   * #13's webhook is what settles the row; this state settles the bar.
   */
  | {
      name: "dialling";
      target: LiveCallTarget;
      callId: string;
      toNumber: string;
    }
```

Add to `CallEvent`:

```ts
  /** Start a Phone Call. No microphone, so no `requesting_mic`. */
  | { type: "START_PHONE"; target: LiveCallTarget }
  | { type: "DIALLING"; callId: string; toNumber: string }
```

- [ ] **Step 4: Add the transitions and `isDismissable`**

In `reduceCall`, add two cases beside the existing ones:

```ts
    case "START_PHONE":
      // Straight to `placing`: a Phone Call needs no microphone, so there is no
      // permission to wait on. Same settled-state guard as START.
      return isSettled(state)
        ? { name: "placing", target: event.target }
        : state;

    case "DIALLING":
      return state.name === "placing"
        ? {
            name: "dialling",
            target: state.target,
            callId: event.callId,
            toNumber: event.toNumber,
          }
        : state;
```

Change the `DISMISS` case:

```ts
    case "DISMISS":
      return isDismissable(state) ? IDLE : state;
```

And add, below `isSettled`:

```ts
/**
 * Whether the bar may be closed.
 *
 * Wider than `isSettled` by exactly one state. A ringing Phone Call is not
 * settled — no second Call may start while it is in flight, and the buttons stay
 * disabled — but it can never settle on its own either, because nothing in the
 * browser will ever hear it end. Closing it is the person's decision, and this
 * is the only state where those two questions have different answers.
 */
export function isDismissable(state: CallState): boolean {
  return isSettled(state) || state.name === "dialling";
}
```

- [ ] **Step 5: Run and watch it pass**

Run: `npx vitest run lib/calls/machine.test.ts`
Expected: PASS, and `npm run typecheck` **also passes** — which is the problem Task 5 fixes.

The `switch (state.name)` in `live-call-bar.tsx` looks exhaustive but is not checked: it has no `default` and no `never` assertion, so it falls off the end, the IIFE returns `undefined`, and React renders nothing. An unhandled `CallState` therefore renders the bar's container as an empty grey strip — and because `busy` is `!isSettled(state)`, an unhandled in-flight state also disables every Call button on the page, with no Dismiss rendered to escape it, since rendering Dismiss is that switch's job. Silently, with nothing in the build to catch it. Task 5 adds both the `dialling` case and the guard.

- [ ] **Step 6: Commit**

```bash
git add lib/calls/machine.ts lib/calls/machine.test.ts
git commit -m "Add dialling, the state that admits what it cannot know

A ringing Phone Call has no SDK and nobody reporting back, so dialling has
no live and no ended transition. It blocks a second Call but stays
dismissable, because nothing else will ever close it.

Issue #19."
```

---

### Task 5: The provider, the bar, and the layout

**Files:**
- Modify: `components/calls/live-call-provider.tsx`
- Modify: `components/calls/live-call-bar.tsx`
- Modify: `app/(app)/layout.tsx`

- [ ] **Step 1: Take the flag as a prop**

In `components/calls/live-call-provider.tsx`, change the signature:

```tsx
export function LiveCallProvider({
  phoneCallsEnabled,
  children,
}: {
  /**
   * Whether this account places Phone Calls. A UI hint, not a permission.
   *
   * It decides four things, all of them browser-side: whether to ask for the
   * microphone, whether to load the SDK, whether to arm the 30-second deadline,
   * and which message a mismatch gets.
   *
   * The server reads the flag itself and is the only thing that chooses the
   * route, so a lying client cannot dial anybody who should not be dialled.
   * Claim "web" on a flagged account and a Phone Call still goes out — to that
   * account's own customer, which is what the flag already permits. Claim
   * "phone" on an unflagged one and you skipped a prompt you did not need and
   * get a Web Call whose token nothing joins. **That second case spends a
   * Call**, so the message for it must say so.
   */
  phoneCallsEnabled: boolean
  children: React.ReactNode
}) {
```

- [ ] **Step 2: Split `place` at the top**

Inside `place`, replace everything from `dispatch({ type: "START", target })` down to and including `dispatch({ type: "MIC_GRANTED" })` with:

```tsx
      if (phoneCallsEnabled) {
        /*
          No microphone, no SDK, no deadline. The token that expires in 30
          seconds is a Web Call's problem; a Phone Call has nothing to join.
        */
        dispatch({ type: "START_PHONE", target })

        const result = await startCallAction(target.appointmentId)
        if (!result.ok) {
          dispatch({ type: "REFUSED", message: result.message })
          return
        }
        if (result.callType !== "phone") {
          // The server disagreed with the hint — the flag was turned off in
          // another tab between render and press. Refuse rather than pretend:
          // the Web Call it placed has no browser waiting to join it.
          dispatch({
            type: "REFUSED",
            /*
              Says a Call was spent, because one was. `startCallAction` already
              claimed the Quota, wrote the row and placed a real Web Call that
              nothing is going to join. A message reading as "nothing happened"
              would invite a second press — and `refused` is settled, so the
              button is live again.
            */
            message:
              "Phone calls are off for this account, so that went out as a " +
              "web call. It used a call and nothing joined it — reload before " +
              "trying again.",
          })
          return
        }

        dispatch({
          type: "DIALLING",
          callId: result.callId,
          toNumber: result.toNumber,
        })
        return
      }

      dispatch({ type: "START", target })

      /*
        The microphone first, before anything is written or spent.

        A decline here costs the account nothing: no Call row, no Retell
        contact, no Quota. That ordering is the whole reason the refund rule can
        stay strict — this is the one failure the browser can prove locally.
      */
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        // We only wanted the answer; the SDK opens its own stream.
        stream.getTracks().forEach((track) => track.stop())
      } catch {
        dispatch({ type: "MIC_DENIED" })
        return
      }
      dispatch({ type: "MIC_GRANTED" })
```

- [ ] **Step 3: Narrow the web branch's result**

Just below the existing `if (!result.ok)` refusal, the web path reads `const { callId, accessToken } = result`. TypeScript now needs the discriminant, so insert this immediately above that line:

```tsx
      if (result.callType !== "web") {
        // The account was flagged between render and press. It got a Phone
        // Call, which is placed and ringing — say so rather than failing.
        dispatch({
          type: "REFUSED",
          message: "That went out as a phone call. Reload to see it.",
        })
        return
      }

      const { callId, accessToken } = result
```

- [ ] **Step 4: Add `phoneCallsEnabled` to `place`'s dependency array**

```tsx
    [releaseClient, tryAudioPlayback, phoneCallsEnabled],
```

- [ ] **Step 5: Render `dialling` in the bar**

In `components/calls/live-call-bar.tsx`, add a case beside `"ended"`:

```tsx
            case "dialling":
              return (
                <>
                  <span className="flex items-center gap-2 text-text">
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full bg-accent animate-live-pulse"
                    />
                    Ringing {state.target.name} at{" "}
                    <span className="font-mono">{state.toNumber}</span>
                  </span>
                  {/*
                    Said plainly rather than hidden. There is no browser on a
                    Phone Call, so nothing here will ever learn that it ended —
                    #13's webhook is what moves the row. A bar that sat spinning
                    forever would read as a hang.
                  */}
                  <span className="text-text-muted">
                    The dashboard updates when the call ends.
                  </span>
                  <Dismiss onClick={dismiss} />
                </>
              )
```

- [ ] **Step 6: Pass the flag from the layout**

In `app/(app)/layout.tsx`:

```tsx
    <LiveCallProvider phoneCallsEnabled={business.phoneCallsEnabled}>
```

- [ ] **Step 7: Confirm the build**

Run: `npm run typecheck && npm run lint && npm test`
Expected: no errors, all tests pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "Skip the microphone and the SDK on the phone route

A Phone Call has nothing to join, so the browser asks for no permission and
loads no client SDK. The bar says it will not learn when the call ends
rather than spinning forever.

Issue #19."
```

---

### Task 6: `setPhoneCallsEnabled` — admin scoped in the statement

**Files:**
- Create: `lib/settings/phone-calls.ts`
- Test: `lib/settings/phone-calls.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/settings/phone-calls.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { provisionUser } from "@/lib/auth/provision-user";
import { db, schema } from "@/lib/db";
import { setPhoneCallsEnabled } from "@/lib/settings/phone-calls";

/*
  The flag that decides whether an account may dial a real phone.

  Every case here is about who may write it, not about what it does — the
  admin check is inside the UPDATE's WHERE clause, so a non-admin's write must
  match zero rows rather than be caught by a branch above it.
*/

const ADMIN_CLERK_ID = "user_test_phone_flag_admin";
const PLAIN_CLERK_ID = "user_test_phone_flag_plain";

let adminBusinessId: string;
let plainBusinessId: string;

async function seed(clerkId: string, isAdmin: boolean): Promise<string> {
  const user = await provisionUser(clerkId, `${clerkId}@example.com`);
  const [business] = await db
    .insert(schema.businesses)
    .values({
      userId: user.id,
      name: "Bandra Dental",
      businessType: "clinic",
      timezone: "Asia/Kolkata",
      isAdmin,
    })
    .returning();
  return business.id;
}

async function cleanup() {
  for (const clerkId of [ADMIN_CLERK_ID, PLAIN_CLERK_ID]) {
    const user = await db.query.users.findFirst({
      where: eq(schema.users.clerkId, clerkId),
    });
    if (!user) continue;
    await db
      .delete(schema.businesses)
      .where(eq(schema.businesses.userId, user.id));
    await db.delete(schema.users).where(eq(schema.users.id, user.id));
  }
}

async function flagOf(businessId: string): Promise<boolean> {
  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.id, businessId),
  });
  return business!.phoneCallsEnabled;
}

beforeEach(async () => {
  await cleanup();
  adminBusinessId = await seed(ADMIN_CLERK_ID, true);
  plainBusinessId = await seed(PLAIN_CLERK_ID, false);
});

afterEach(cleanup);

describe("setPhoneCallsEnabled", () => {
  it("starts off for every account", async () => {
    expect(await flagOf(adminBusinessId)).toBe(false);
    expect(await flagOf(plainBusinessId)).toBe(false);
  });

  it("lets an admin turn it on", async () => {
    expect(await setPhoneCallsEnabled(adminBusinessId, true)).toBe(true);
    expect(await flagOf(adminBusinessId)).toBe(true);
  });

  it("lets an admin turn it off again", async () => {
    await setPhoneCallsEnabled(adminBusinessId, true);

    expect(await setPhoneCallsEnabled(adminBusinessId, false)).toBe(true);
    expect(await flagOf(adminBusinessId)).toBe(false);
  });

  it("writes nothing for a non-admin", async () => {
    expect(await setPhoneCallsEnabled(plainBusinessId, true)).toBe(false);
    expect(await flagOf(plainBusinessId)).toBe(false);
  });

  it("writes nothing for a Business that does not exist", async () => {
    const absent = "00000000-0000-0000-0000-000000000000";

    expect(await setPhoneCallsEnabled(absent, true)).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run lib/settings/phone-calls.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/settings/phone-calls"`.

- [ ] **Step 3: Write the implementation**

Create `lib/settings/phone-calls.ts`:

```ts
import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/*
  Turning the Phone Call flag on and off (SPEC.md §3 rule 9, §14 rule 6).

  The admin check is in the WHERE clause, not in a branch above the write. A
  Server Action is a POST anybody can send, and rendering a switch on an
  admin-gated screen is not a security boundary — so a non-admin's update has to
  match zero rows rather than be caught by an `if` somebody could reorder.

  Same discipline as `claimCallQuota` and every cross-tenant guard in `lib/`:
  scope in the statement.

  Worth knowing why a UI control on this flag is defensible at all on an
  open-signup product: `businesses.is_admin` is never written by application
  code. Nothing in the codebase sets it, and SPEC.md §14 rule 9 rules out the
  roles UI that would. Reaching this write means somebody typed an UPDATE into a
  database console first.
*/

/**
 * Sets `phone_calls_enabled`, if the Business is an admin account.
 *
 * Returns whether a row changed. False covers three situations — not an admin,
 * no such Business, and an id from another account — and they get the same
 * answer deliberately: none of them may write, and a caller holding an id that
 * resolves to nothing has no business knowing which it was.
 */
export async function setPhoneCallsEnabled(
  businessId: string,
  enabled: boolean,
): Promise<boolean> {
  const rows = await db
    .update(schema.businesses)
    .set({ phoneCallsEnabled: enabled })
    .where(
      and(
        eq(schema.businesses.id, businessId),
        eq(schema.businesses.isAdmin, true),
      ),
    )
    .returning({ id: schema.businesses.id });

  return rows.length > 0;
}
```

- [ ] **Step 4: Run and watch it pass**

Run: `npx vitest run lib/settings/phone-calls.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/settings/phone-calls.ts lib/settings/phone-calls.test.ts
git commit -m "Put the admin check inside the flag's UPDATE

A non-admin's write matches zero rows rather than hitting a branch above the
statement. Same discipline as claimCallQuota.

Issue #19."
```

---

### Task 7: The Settings section

**Files:**
- Modify: `app/(app)/settings/actions.ts`
- Create: `components/settings/phone-calls-section.tsx`
- Modify: `app/(app)/settings/page.tsx`

- [ ] **Step 1: Add the Server Action**

At the end of `app/(app)/settings/actions.ts`, beside `disconnectGoogleCalendarAction`:

```ts
/**
 * Turns Phone Calls on or off for this account (issue #19).
 *
 * `requireBusiness()` first, as everywhere in this file. The admin check is not
 * here — it is inside `setPhoneCallsEnabled`'s WHERE clause, so this action
 * being reachable by a POST from a non-admin writes nothing rather than relying
 * on the page that rendered the form.
 *
 * Takes `FormData`, so nothing is closed over (rule 2 above). The desired state
 * travels in a hidden field rather than being inferred from the current one: a
 * form submitted twice from a stale render must land on the value it named, not
 * flip whatever it finds.
 */
export async function setPhoneCallsEnabledAction(
  formData: FormData,
): Promise<void> {
  const { business } = await requireBusiness();

  await setPhoneCallsEnabled(business.id, field(formData, "enabled") === "on");

  revalidatePath("/settings");
  // The route every "Call now" takes has just changed.
  revalidatePath("/");
}
```

Add the import:

```ts
import { setPhoneCallsEnabled } from "@/lib/settings/phone-calls";
```

- [ ] **Step 2: Write the section**

Create `components/settings/phone-calls-section.tsx`:

```tsx
import type * as React from "react"

import { setPhoneCallsEnabledAction } from "@/app/(app)/settings/actions"
import { PendingSubmitButton } from "@/components/settings/pending-submit-button"
import { SettingsCallout, SettingsSection } from "@/components/settings/section"

/**
 * The Phone Call switch (SPEC.md §3 rule 9, §14 rule 6, issue #19).
 *
 * **This must never render for a non-admin.** The gate is `businesses.is_admin`
 * on the page, and it is not re-checked here — one owner of an authorisation
 * decision, the same argument `env-status-section.tsx` makes. The write itself
 * is separately scoped to admins inside its own UPDATE, so a form posted
 * without the page still writes nothing.
 *
 * A form and a button rather than a live switch, matching
 * `google-calendar-section.tsx`. It keeps the section a Server Component and
 * gets a per-button spinner from `PendingSubmitButton` for nothing — SPEC.md
 * §11.4 wants a loading state on the button, not a full-page blocker.
 *
 * The section renders two things beyond the button, and both are load-bearing.
 * It says what turning this on means, in the plainest words available, because
 * the flag is the difference between a demo and a robocaller. And it says when
 * the flag will not help: on with `RETELL_FROM_NUMBER` blank is a real state,
 * and finding out by placing a Call that gets refused is a worse way to learn
 * it.
 */
export function PhoneCallsSection({
  enabled,
  fromNumberSet,
}: {
  enabled: boolean
  /** Whether `RETELL_FROM_NUMBER` is set. A boolean — never the value. */
  fromNumberSet: boolean
}): React.JSX.Element {
  return (
    <SettingsSection
      title="Phone calls"
      description="Whether Maya calls a customer's phone instead of running in this browser. Off for every account by default."
    >
      <div className="flex flex-col gap-5">
        {enabled ? (
          <SettingsCallout tone="warning" title="Phone calls are on">
            Every &ldquo;Call now&rdquo; on this account dials the number on the
            appointment. Calls to a real phone cost roughly ten times a browser
            call and count against the same quota.
          </SettingsCallout>
        ) : (
          <SettingsCallout title="Phone calls are off">
            &ldquo;Call now&rdquo; runs the conversation in this browser. Nothing
            on this account can dial a phone.
          </SettingsCallout>
        )}

        {enabled && !fromNumberSet ? (
          <SettingsCallout
            tone="warning"
            title="No outbound number is configured"
          >
            <span className="font-mono">RETELL_FROM_NUMBER</span> is not set on
            this deployment, so every phone call will be refused before it is
            placed. No quota is spent when that happens.
          </SettingsCallout>
        ) : null}

        <form action={setPhoneCallsEnabledAction}>
          {/*
            The value named, not inferred. A form submitted twice from a stale
            render must land where it said, rather than flipping whatever it
            finds.
          */}
          <input type="hidden" name="enabled" value={enabled ? "off" : "on"} />
          <PendingSubmitButton
            label={enabled ? "Turn off phone calls" : "Turn on phone calls"}
            pendingLabel={enabled ? "Turning off…" : "Turning on…"}
            variant={enabled ? "destructive" : "default"}
          />
        </form>
      </div>
    </SettingsSection>
  )
}
```

- [ ] **Step 3: Render it inside the existing admin block**

In `app/(app)/settings/page.tsx`, replace the `{business.isAdmin ? … : null}` expression with:

```tsx
      {business.isAdmin ? (
        <>
          <PhoneCallsSection
            enabled={business.phoneCallsEnabled}
            fromNumberSet={
              envStatus(process.env).find(
                (variable) => variable.name === "RETELL_FROM_NUMBER",
              )?.set ?? false
            }
          />
          <EnvStatusSection variables={envStatus(process.env)} />
        </>
      ) : null}
```

Add the import:

```tsx
import { PhoneCallsSection } from "@/components/settings/phone-calls-section"
```

- [ ] **Step 4: Confirm the build**

Run: `npm run typecheck && npm run lint && npm test`
Expected: no errors, all tests pass.

- [ ] **Step 5: Check it by hand, for free**

```bash
npm run dev
```

Sign in as a normal account, open `/settings`, and view source: there must be no "Phone calls" section anywhere in the HTML.

Then promote the account and reload:

```sql
UPDATE businesses SET is_admin = true WHERE id = '<your business id>';
```

Expected: the section appears, says "Phone calls are off", and the button reads "Turn on phone calls". Press it with `RETELL_FROM_NUMBER` blank. Expected: the section says it is on and warns that no outbound number is configured. Press "Call now" on any row. Expected: the bar refuses with the `RETELL_FROM_NUMBER` message, the quota meter does not move, and no new Call row exists.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Add the admin-only phone call switch

Gated on the page so a non-admin's HTML never contains it, and scoped again
inside the UPDATE so a posted form without the page writes nothing. Says
when the flag will not help: on with RETELL_FROM_NUMBER blank is a real
state and a refused Call is a bad way to discover it.

Issue #19."
```

---

### Task 8: The ADR, the runbook, and `.env.example`

**Files:**
- Create: `docs/adr/0012-phone-route-chosen-by-the-flag.md`
- Create: `docs/runbooks/phone-call-preflight.md`
- Modify: `.env.example`

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0012-phone-route-chosen-by-the-flag.md`, following the shape of the existing ADRs in that directory (read `docs/adr/0011-tools-prove-an-offer-by-replaying-tool-invocations.md` for the house format before writing). It must record:

- **Decision:** `startCall` selects `businesses.phone_calls_enabled` in the same scoped read that fetches the Appointment, and the route is that column. There is no separate guard and no route parameter anywhere.
- **Why:** SPEC.md §3 rule 9 and §14 rule 6 forbid a Phone Call from an unflagged account. A guard is something a future caller can forget; a route selection is not. `createPhoneCall` is reachable from exactly one branch, and the condition on that branch is the flag.
- **Rejected — a `startPhoneCall` function that checks the flag first.** Works until a second caller is added. The failure is silent, outbound, and to a stranger.
- **Rejected — a `route` argument on the Server Action.** A Server Action is a POST anybody can send, so an argument that selects the route is a way to ask for a Phone Call.
- **Cost, stated honestly:** a flagged account cannot place a cheap Web Call without turning the flag off first. Accepted — the switch is one click, and one flag beats two pieces of state that can disagree.
- **Revisit if:** accounts ever need both routes at once (a per-Appointment choice, or Web Calls for rehearsal on a flagged account). That would need the route to become an argument, and then it needs its own server-side authorisation rather than inheriting one.

- [ ] **Step 2: Write the runbook**

Create `docs/runbooks/phone-call-preflight.md` with exactly these steps, in this order:

1. **Complete Retell KYC.** Record which of the three paths you land in — automatic, Persona, or manual review (`docs/verification.md` A1). Manual review means stop: fire the kill switch and go to step 7's blocked branch. That is a finding, not a failure.
2. **Buy a $2 US local number.** Record whether a card was required — that answers SPEC.md §13 item 1, currently UNVERIFIED in `docs/verification.md` A1.
3. **Set `RETELL_FROM_NUMBER`** in `.env.local` and on the Cloud Run service, then restart it. Confirm on `/settings` that the Configuration panel shows it as Set.
4. **Settle India from Retell's dashboard, before Callzie touches it.** Place one call from the new number to your own +91 mobile. ~$0.25. Read `disconnection_reason` on the call in the dashboard:
   - It connects → **supported**.
   - `invalid_destination`, `telephony_provider_permission_denied` or `dial_failed` → **blocked**.
5. **Record the answer in `docs/verification.md`** — Decision 1 in the table at the top, and the "⚠️ The blocking contradiction" subsection of A2. Give the date and the exact `disconnection_reason`. Replace the contradiction with the resolved answer; do not leave both.
6. **If supported.** Promote your account: `UPDATE businesses SET is_admin = true WHERE id = '<your business id>';`. On `/settings`, turn phone calls on. On Overview, quick-add an Appointment with **your own number** — the seeded rows use the reserved fictional `+1 202 555 01xx` range and the app now refuses them. Press "Call now". Listen for your name and the right time, and confirm the call ends inside 120 seconds (`max_call_duration_ms` is already 120,000 in `scripts/create-agent.ts`, so this observes the cap rather than adding one). ~$0.50. Then turn the switch back off so the deployed demo account cannot dial.
7. **If blocked.** Change nothing — the flag defaults off and nothing has set it, so the kill switch is already fired. Write the finding into `docs/verification.md` and into the README's stated limitations. The story becomes "phone delivery is a config change", proven rather than claimed.

Open the runbook with a paragraph saying plainly that none of this is automated, that step 4 is the whole kill switch, and that everything else in Callzie ships either way.

- [ ] **Step 3: Update `.env.example`**

Replace the comment above `RETELL_FROM_NUMBER` with:

```
# The US number you bought from Retell, in E.164. Read by the Phone Call path
# (issue #19) — blank means a flagged account's Phone Calls are refused before
# anything is spent, rather than failing at Retell. Unflagged accounts place Web
# Calls and never read this. See docs/runbooks/phone-call-preflight.md.
RETELL_FROM_NUMBER=
```

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0012-phone-route-chosen-by-the-flag.md docs/runbooks/phone-call-preflight.md .env.example
git commit -m "Record why the flag chooses the route, and how to prove India

The ADR names the rejected alternative that matters: a startPhoneCall that
checks the flag first works until a second caller forgets, and that failure
is silent and outbound.

The runbook is the part no code can do. Step 4 is the whole kill switch.

Issue #19."
```

---

### Task 9: Full green, and the acceptance criteria read back

**Files:** none

- [ ] **Step 1: Run everything**

Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: all pass.

- [ ] **Step 2: Check each acceptance criterion against a specific test or step**

Read issue #19's list and name what proves each one. Four are proven now:

| Criterion | Proof |
|---|---|
| No unflagged account can place a Phone Call by any route | `lib/calls/start-call.test.ts` — "never dials for an account without the flag", plus there being no route argument on `startCallAction` |
| Same webhook path, no branching on call type | `startCall` sends identical `metadata` on both routes; `call_type` is written and nothing reads it to decide |
| Every real Call inside 120 seconds | `max_call_duration_ms: 120_000` in `scripts/create-agent.ts`, unchanged |
| If blocked, the flag stays off | It is the default; nothing but the admin switch writes it |

Two need the runbook and cannot be closed here:

- A flagged account rings a real phone, with the right name and time.
- The India question settled empirically and recorded in `docs/verification.md`.

- [ ] **Step 3: Report honestly**

Say plainly which criteria are proven and which are waiting on the runbook. Do not report #19 complete until steps 4 through 7 of the runbook have been done and the answer is written into `docs/verification.md`.

- [ ] **Step 4: Commit anything outstanding**

```bash
git status
```

Expected: clean.

---

## What this plan does not build

The webhook receiver (#13), extraction (#14), the Needs Attention surface (#15),
`/calls/[id]` (#16), and Call all / retry on no answer (#17).

A Phone Call's row stays `calling` until #13 exists, because the only honest
source for its outcome is Retell and there is no browser on the line to report.
The bar says so and offers Dismiss. See the spec's "What #19 does not own" for
the two alternatives that were considered and rejected.
