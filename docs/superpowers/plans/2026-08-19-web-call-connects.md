# Web Call connects, and the quota holds — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pressing "Call now" starts a real conversation with Maya in the browser, the Quota holds against concurrent presses, and both failure modes — a declined microphone and an expired access token — are designed states rather than stack traces.

**Architecture:** The microphone is requested in the browser *before* any row is written or Retell is contacted, so a decline costs nothing. The Quota is claimed by one conditional `UPDATE` so two tabs cannot both pass on the fifth Call. A pure reducer drives every UI state, which is how both failure states get tested without a browser, without Retell, and without spending money.

**Tech Stack:** Next.js 16 App Router, TypeScript, Drizzle + Postgres, `retell-sdk` (server), `retell-client-js-sdk` (browser), Vitest against a local embedded Postgres.

**Spec:** `docs/superpowers/specs/2026-08-19-web-call-connects-design.md`

---

## File structure

**New**

| File | Responsibility |
|---|---|
| `lib/calls/dynamic-variables.ts` | Build and validate the four `{{...}}` values. Pure. |
| `lib/calls/quota.ts` | The atomic claim and its release. |
| `lib/calls/machine.ts` | The ten UI states and the transitions between them. Pure. |
| `lib/calls/start-web-call.ts` | Orchestration: validate → claim → insert → Retell → compensate. |
| `lib/business/active-calls.ts` | Which Calls count as live, and the staleness window. |
| `app/(app)/calls/actions.ts` | The four Server Actions. |
| `components/calls/live-call-provider.tsx` | Owns the SDK, the mic, the timer, the refresh. |
| `components/calls/live-call-bar.tsx` | Renders every designed state. |
| `components/calls/call-now-button.tsx` | The row action. |

**Modified**

| File | Change |
|---|---|
| `app/(app)/layout.tsx` | Real active count; the provider wraps children |
| `app/(app)/actions.ts` | `QuickAddState.added` gains `id` |
| `app/(app)/page.tsx` | Pass live ids and Quota through |
| `components/overview/quick-call-card.tsx` | Button becomes "Call now", chains the dial |
| `components/overview/appointments-table.tsx` | Row action and shimmer |
| `lib/business/list-appointments.ts` | `isCalling` on the row |
| `app/globals.css` | Shimmer keyframes |
| `package.json` | `retell-client-js-sdk` |

**Two refinements to the spec, made while writing this plan:**

1. `validateDynamicVariables` returns `{ ok: false; invalid: string[] }`, not `missing`. It catches three problems — absent, non-string, and empty — and "missing" only names the first.
2. `StartWebCallResult` does **not** carry `deadlineAt`. The 30-second deadline is computed in the browser when the token arrives, so a clock skew between the server and the viewer cannot expire a healthy token early.

---

### Task 0: Install dependencies and confirm the toolchain is green

`node_modules/` is absent in this worktree. Nothing below can run until it exists, and a baseline green run means every later failure belongs to this work.

**Files:**
- Modify: `package.json`

- [x] **Step 1: Install the existing dependencies**

```bash
npm install
```

- [x] **Step 2: Confirm the suite is green before any change**

Run: `npm test`
Expected: all existing tests pass. If any fail, stop and report — do not build on a red baseline.

- [x] **Step 3: Add the browser SDK**

```bash
npm install retell-client-js-sdk
```

- [x] **Step 4: Confirm typecheck still passes**

Run: `npm run typecheck`
Expected: no errors.

- [x] **Step 5: Read the Next.js 16 guides this work touches**

The repo's `CLAUDE.md` warns that this Next.js differs from training data. Before writing any component, read:

```bash
ls node_modules/next/dist/docs/
```

Read whichever of those cover Server Actions and client/server component boundaries. Note anything that contradicts the code in this plan and follow the docs, not the plan.

- [x] **Step 6: Commit**

```bash
git add package.json package-lock.json
git commit -m "Add the Retell browser SDK, which carries the Web Call audio"
```

---

### Task 1: The four dynamic variables, and the placeholder sweep

This is acceptance criterion 2 — "no literal double-brace placeholder is ever spoken aloud" — proven for all four Templates without spending anything.

**Files:**
- Create: `lib/calls/dynamic-variables.ts`
- Test: `lib/calls/dynamic-variables.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// lib/calls/dynamic-variables.test.ts
import { describe, expect, it } from "vitest";

import {
  buildDynamicVariables,
  renderPromptVariables,
  validateDynamicVariables,
} from "@/lib/calls/dynamic-variables";
import { buildPrompt, PROMPT_VARIABLES, TEMPLATES } from "@/lib/retell/templates";

// 14:30 Asia/Kolkata on Tuesday 2026-08-18.
const STARTS_AT = new Date("2026-08-18T09:00:00.000Z");

function build() {
  return buildDynamicVariables({
    businessName: "Bandra Dental",
    name: "Priya Nair",
    serviceName: "Cleaning",
    startsAt: STARTS_AT,
    timezone: "Asia/Kolkata",
  });
}

describe("buildDynamicVariables", () => {
  it("produces exactly the keys the prompts expect", () => {
    expect(Object.keys(build()).sort()).toEqual([...PROMPT_VARIABLES].sort());
  });

  it("makes every value a string, because Retell rejects anything else", () => {
    // docs/verification.md A5: "All values in retell_llm_dynamic_variables must
    // be strings." A Date here fails at call time, not at build time.
    for (const value of Object.values(build())) {
      expect(typeof value).toBe("string");
    }
  });

  it("renders the time in the Business's own timezone", () => {
    // 09:00 UTC is 14:30 in Kolkata. Maya must say the customer's time, not ours.
    expect(build().time).toContain("14:30");
  });
});

describe("validateDynamicVariables", () => {
  it("accepts a complete set", () => {
    expect(validateDynamicVariables(build())).toEqual({ ok: true });
  });

  it("names a missing key", () => {
    const vars = build();
    delete vars.name;
    expect(validateDynamicVariables(vars)).toEqual({ ok: false, invalid: ["name"] });
  });

  it("rejects an empty string, which Retell replaces with nothing", () => {
    // Maya would say "your appointment on" and stop.
    expect(validateDynamicVariables({ ...build(), time: "" })).toEqual({
      ok: false,
      invalid: ["time"],
    });
  });

  it("rejects a non-string value", () => {
    const vars = { ...build(), name: 42 } as unknown as Record<string, string>;
    expect(validateDynamicVariables(vars)).toEqual({ ok: false, invalid: ["name"] });
  });

  it("names every problem at once", () => {
    expect(
      validateDynamicVariables({ ...build(), name: "", time: "" }),
    ).toEqual({ ok: false, invalid: ["name", "time"] });
  });
});

describe("no placeholder ever reaches the caller", () => {
  // Acceptance criterion 2. An unset variable renders literally, so a plumbing
  // bug means Maya says "curly-curly-name" out loud (docs/verification.md A5).
  it.each(TEMPLATES.map((t) => [t.businessType, t] as const))(
    "leaves no double brace in the %s prompt or begin message",
    (_type, template) => {
      const vars = build();

      expect(renderPromptVariables(buildPrompt(template), vars)).not.toMatch(/\{\{|\}\}/);
      expect(renderPromptVariables(template.beginMessage, vars)).not.toMatch(/\{\{|\}\}/);
    },
  );
});
```

- [x] **Step 2: Run it to make sure it fails**

Run: `npx vitest run lib/calls/dynamic-variables.test.ts`
Expected: FAIL — cannot resolve `@/lib/calls/dynamic-variables`.

- [x] **Step 3: Write the implementation**

```ts
// lib/calls/dynamic-variables.ts
import { PROMPT_VARIABLES } from "@/lib/retell/templates";
import { formatInZone } from "@/lib/time/zone";

/*
  The values Retell substitutes into the prompt at call time (SPEC.md §7).

  Two facts from docs/verification.md A5 shape this whole file. Every value must
  be a string — a Date or a number is rejected by the API. And an unset variable
  renders LITERALLY to the caller, so a missing key does not fail loudly, it makes
  Maya say "curly-curly-name" to a customer. That is why validation happens here,
  before anything is spent, rather than being discovered on the call.
*/

/** Key/value pairs for `retell_llm_dynamic_variables`. Strings only. */
export type DynamicVariables = Record<string, string>;

export function buildDynamicVariables(input: {
  businessName: string;
  name: string;
  serviceName: string;
  startsAt: Date;
  /** The Business's IANA zone. The time means nothing without it. */
  timezone: string;
}): DynamicVariables {
  return {
    business_name: input.businessName,
    name: input.name,
    service: input.serviceName,
    // Formatted here, never passed as a Date. This is the conversion A5 warns about.
    time: formatInZone(input.startsAt, input.timezone),
  };
}

export type VariableCheck =
  | { ok: true }
  | { ok: false; invalid: string[] };

/**
 * Whether every variable the prompts reference is present and speakable.
 *
 * Three problems, one answer: absent, not a string, or empty. Empty is rejected
 * rather than allowed because Retell replaces it with nothing — Maya would say
 * "your appointment on" and stop, which is worse than an obvious placeholder.
 */
export function validateDynamicVariables(vars: DynamicVariables): VariableCheck {
  const invalid = PROMPT_VARIABLES.filter((key) => {
    const value = vars[key];
    return typeof value !== "string" || value.trim() === "";
  });

  return invalid.length === 0 ? { ok: true } : { ok: false, invalid };
}

/**
 * Substitutes `{{key}}` the way Retell does.
 *
 * **Not used at call time** — Retell performs the real substitution on its own
 * side. This exists so the test suite can prove that a rendered prompt contains
 * no surviving placeholder, for every Template, without placing a Call. It lives
 * beside `PROMPT_VARIABLES` because it is a model of the contract those variables
 * are half of, and a copy in a test file would drift from it.
 */
export function renderPromptVariables(
  text: string,
  vars: DynamicVariables,
): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) =>
    typeof vars[key] === "string" ? vars[key] : whole,
  );
}
```

- [x] **Step 4: Run the tests**

Run: `npx vitest run lib/calls/dynamic-variables.test.ts`
Expected: PASS, including four parameterised placeholder-sweep cases.

- [x] **Step 5: Commit**

```bash
git add lib/calls/dynamic-variables.ts lib/calls/dynamic-variables.test.ts
git commit -m "Build the four dynamic variables, and prove no placeholder survives"
```

---

### Task 2: The Quota holds under concurrency

Acceptance criteria 3 and 4. The test that matters is the concurrent one — a read-then-write implementation passes everything else in this file and fails that.

**Files:**
- Create: `lib/calls/quota.ts`
- Test: `lib/calls/quota.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// lib/calls/quota.test.ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { provisionUser } from "@/lib/auth/provision-user";
import { claimCallQuota, releaseCallQuota } from "@/lib/calls/quota";
import { db, schema } from "@/lib/db";

const CLERK_ID = "user_test_calls_quota";

let businessId: string;

async function cleanup() {
  const user = await db.query.users.findFirst({
    where: eq(schema.users.clerkId, CLERK_ID),
  });
  if (!user) return;

  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.userId, user.id),
  });
  if (business) {
    await db.delete(schema.businesses).where(eq(schema.businesses.id, business.id));
  }
  await db.delete(schema.users).where(eq(schema.users.clerkId, CLERK_ID));
}

async function makeBusiness(overrides: Partial<typeof schema.businesses.$inferInsert> = {}) {
  const user = await provisionUser(CLERK_ID, "quota@example.com");
  const [business] = await db
    .insert(schema.businesses)
    .values({
      userId: user.id,
      name: "Quota Test Clinic",
      businessType: "clinic",
      timezone: "Asia/Kolkata",
      ...overrides,
    })
    .returning();
  businessId = business.id;
  return business;
}

async function callsUsed(): Promise<number> {
  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.id, businessId),
  });
  return business!.callsUsed;
}

beforeEach(cleanup);
afterEach(cleanup);

describe("claimCallQuota", () => {
  it("succeeds while Calls remain", async () => {
    await makeBusiness({ callsUsed: 4, callQuota: 5 });

    expect(await claimCallQuota(db, businessId)).toEqual({ ok: true, callsUsed: 5 });
  });

  it("refuses the sixth Call", async () => {
    await makeBusiness({ callsUsed: 5, callQuota: 5 });

    expect(await claimCallQuota(db, businessId)).toEqual({ ok: false, reason: "exhausted" });
    // And nothing moved.
    expect(await callsUsed()).toBe(5);
  });

  it("does not limit an admin account", async () => {
    // Acceptance criterion 4.
    await makeBusiness({ callsUsed: 99, callQuota: 5, isAdmin: true });

    expect(await claimCallQuota(db, businessId)).toEqual({ ok: true, callsUsed: 100 });
  });

  it("still counts an admin's Calls", async () => {
    // calls_used is the record of what was spent. Frozen at zero it is a lie,
    // even though the sidebar renders "Unlimited" rather than the number.
    await makeBusiness({ callsUsed: 0, callQuota: 5, isAdmin: true });

    await claimCallQuota(db, businessId);

    expect(await callsUsed()).toBe(1);
  });
});

describe("releaseCallQuota", () => {
  it("gives a Call back", async () => {
    await makeBusiness({ callsUsed: 3, callQuota: 5 });

    await releaseCallQuota(db, businessId);

    expect(await callsUsed()).toBe(2);
  });

  it("floors at zero, so a double release cannot go negative", async () => {
    await makeBusiness({ callsUsed: 0, callQuota: 5 });

    await releaseCallQuota(db, businessId);

    expect(await callsUsed()).toBe(0);
  });
});

/*
  The test this file exists for. A read-then-write implementation passes every
  test above and fails this one: both callers read "four used" and both write
  "five", and the account places six Calls.
*/
describe("the Quota under concurrency", () => {
  it("lets exactly five of ten simultaneous claims through", async () => {
    await makeBusiness({ callsUsed: 0, callQuota: 5 });

    // Genuine contention: each statement takes its own connection from the pool,
    // and Postgres serialises them on the row lock rather than the application
    // ordering them. Same technique as lib/availability/book.test.ts.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimCallQuota(db, businessId)),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok)).toHaveLength(5);
    // And the database agrees — five, not ten.
    expect(await callsUsed()).toBe(5);
  });
});
```

- [x] **Step 2: Run it to make sure it fails**

Run: `npx vitest run lib/calls/quota.test.ts`
Expected: FAIL — cannot resolve `@/lib/calls/quota`.

- [x] **Step 3: Write the implementation**

```ts
// lib/calls/quota.ts
import { sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/*
  Claiming one Call against an account's Quota (SPEC.md §3, §11.1).

  The obvious shape — read calls_used, compare it to call_quota, then write — has
  the same defect as a pre-check in front of bookSlot. Two tabs both read "four
  used" and both write "five", and the account places six Calls.

  So the check and the increment are one statement. Postgres takes a row lock for
  the UPDATE, so contending statements serialise and no gap exists between the
  read and the write for a second Call to slip through. Same lesson as
  appointments_no_overlap (SPEC.md §3 rule 8), applied to a counter instead of a
  range.
*/

/** `db`, or a transaction handle from `db.transaction`. */
export type Executor =
  | typeof db
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type QuotaClaim =
  | { ok: true; callsUsed: number }
  | { ok: false; reason: "exhausted" };

/**
 * Takes one Call from the Quota, or refuses.
 *
 * Takes an executor rather than reaching for `db`, so the caller can put this in
 * the same transaction as the `calls` insert — a claimed Call with no row would
 * charge someone for nothing.
 *
 * An admin skips the bound but still increments. `calls_used` is the record of
 * what the account spent, and a counter frozen at zero while Calls go out is
 * simply wrong, even though the sidebar renders "Unlimited" rather than a number.
 */
export async function claimCallQuota(
  executor: Executor,
  businessId: string,
): Promise<QuotaClaim> {
  const result = await executor.execute(sql`
    UPDATE ${schema.businesses}
       SET ${schema.businesses.callsUsed} = ${schema.businesses.callsUsed} + 1
     WHERE ${schema.businesses.id} = ${businessId}
       AND (${schema.businesses.isAdmin} = true
            OR ${schema.businesses.callsUsed} < ${schema.businesses.callQuota})
    RETURNING ${schema.businesses.callsUsed} AS calls_used
  `);

  const row = result.rows[0] as { calls_used: number } | undefined;
  // No row means the WHERE clause refused it: the Quota is gone. A missing
  // Business also lands here, which is the right answer for it too.
  if (!row) return { ok: false, reason: "exhausted" };

  return { ok: true, callsUsed: Number(row.calls_used) };
}

/**
 * Gives a Call back.
 *
 * The compensating half of `claimCallQuota`, for the one case that earns it:
 * `create-web-call` failed, so nothing was placed and nothing should be charged.
 * That failure is provable on the server, which is what separates it from a
 * browser claiming a Call did not connect.
 *
 * Floors at zero. A double release must not produce a negative count.
 */
export async function releaseCallQuota(
  executor: Executor,
  businessId: string,
): Promise<void> {
  await executor.execute(sql`
    UPDATE ${schema.businesses}
       SET ${schema.businesses.callsUsed} = GREATEST(${schema.businesses.callsUsed} - 1, 0)
     WHERE ${schema.businesses.id} = ${businessId}
  `);
}
```

- [x] **Step 4: Run the tests**

Run: `npx vitest run lib/calls/quota.test.ts`
Expected: PASS, including the ten-way concurrency test.

- [x] **Step 5: Commit**

```bash
git add lib/calls/quota.ts lib/calls/quota.test.ts
git commit -m "Claim the Quota in one statement, so the sixth Call cannot slip through"
```

---

### Task 3: The reducer behind every designed state

Acceptance criterion 5. Both failure states are driven directly here — nobody waits 30 seconds or declines a real microphone prompt to see them.

**Files:**
- Create: `lib/calls/machine.ts`
- Test: `lib/calls/machine.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// lib/calls/machine.test.ts
import { describe, expect, it } from "vitest";

import {
  type CallEvent,
  type CallState,
  IDLE,
  reduceCall,
} from "@/lib/calls/machine";

const TARGET = { appointmentId: "appt-1", name: "Priya Nair" };

/** Replays a sequence from idle, so each test reads as the story it tests. */
function run(...events: CallEvent[]): CallState {
  return events.reduce(reduceCall, IDLE);
}

const toLive: CallEvent[] = [
  { type: "START", target: TARGET },
  { type: "MIC_GRANTED" },
  { type: "PLACED", callId: "call-1", deadlineAt: 30_000 },
  { type: "SDK_CALL_STARTED", at: 1_000 },
];

describe("the happy path", () => {
  it("walks idle → requesting_mic → placing → connecting → live → ended", () => {
    expect(run({ type: "START", target: TARGET }).name).toBe("requesting_mic");
    expect(run(...toLive.slice(0, 2)).name).toBe("placing");
    expect(run(...toLive.slice(0, 3)).name).toBe("connecting");
    expect(run(...toLive).name).toBe("live");
    expect(run(...toLive, { type: "SDK_CALL_ENDED" }).name).toBe("ended");
  });

  it("carries the person's name all the way through, for the bar to show", () => {
    const state = run(...toLive);
    expect(state.name === "live" && state.target.name).toBe("Priya Nair");
  });
});

describe("the designed failure states", () => {
  it("reaches mic_denied without a browser", () => {
    expect(run({ type: "START", target: TARGET }, { type: "MIC_DENIED" }).name).toBe(
      "mic_denied",
    );
  });

  it("reaches expired without waiting 30 seconds", () => {
    expect(run(...toLive.slice(0, 3), { type: "DEADLINE_PASSED" }).name).toBe("expired");
  });

  it("reaches refused when the server declines", () => {
    const state = run(...toLive.slice(0, 2), {
      type: "REFUSED",
      message: "You've used all 5 of your calls.",
    });
    expect(state).toEqual({
      name: "refused",
      target: TARGET,
      message: "You've used all 5 of your calls.",
    });
  });

  it("reaches failed when the SDK errors", () => {
    expect(run(...toLive, { type: "SDK_ERROR", message: "boom" }).name).toBe("failed");
  });
});

describe("the three guards", () => {
  it("ignores the deadline once the Call is live", () => {
    // The 30s timer is still running when the Call connects at second three.
    // Without this guard it fires at second thirty and kills a healthy call.
    expect(run(...toLive, { type: "DEADLINE_PASSED" }).name).toBe("live");
  });

  it("does not resurrect a failed Call when the SDK also reports it ended", () => {
    // The SDK may emit both, in either order.
    const state = run(...toLive, { type: "SDK_ERROR", message: "boom" }, {
      type: "SDK_CALL_ENDED",
    });
    expect(state.name).toBe("failed");
  });

  it("ignores a late call_started after the Call has ended", () => {
    const state = run(...toLive, { type: "SDK_CALL_ENDED" }, {
      type: "SDK_CALL_STARTED",
      at: 9_000,
    });
    expect(state.name).toBe("ended");
  });
});

describe("starting another Call", () => {
  it("refuses to start while one is live, so a double click cannot abandon it", () => {
    const state = run(...toLive, { type: "START", target: { appointmentId: "appt-2", name: "Arun" } });
    expect(state.name).toBe("live");
    expect(state.name === "live" && state.target.appointmentId).toBe("appt-1");
  });

  it("allows a new Call once the last one settled", () => {
    const state = run(...toLive, { type: "SDK_CALL_ENDED" }, {
      type: "START",
      target: { appointmentId: "appt-2", name: "Arun" },
    });
    expect(state.name).toBe("requesting_mic");
  });

  it("returns to idle when a settled state is dismissed", () => {
    expect(run(...toLive, { type: "SDK_CALL_ENDED" }, { type: "DISMISS" })).toEqual(IDLE);
  });

  it("ignores a dismiss while the Call is live", () => {
    expect(run(...toLive, { type: "DISMISS" }).name).toBe("live");
  });
});
```

- [x] **Step 2: Run it to make sure it fails**

Run: `npx vitest run lib/calls/machine.test.ts`
Expected: FAIL — cannot resolve `@/lib/calls/machine`.

- [x] **Step 3: Write the implementation**

```ts
// lib/calls/machine.ts

/*
  The state of the Call currently on screen (SPEC.md §11.3, §11.4).

  Named for the live Call rather than a "session": CONTEXT.md rules that word out
  as a synonym for Call.

  A plain reducer, deliberately. Every state the sticky bar can render is
  reachable by dispatching events at this function, so both of #11's designed
  failure states — a declined microphone and an expired access token — are tested
  without a browser, without Retell, and without spending anything (SPEC.md §3
  rule 11). The component wires SDK events to `dispatch` and renders; it decides
  nothing.
*/

/** Who this Call is for. The bar says the name; the row shimmers on the id. */
export type LiveCallTarget = {
  appointmentId: string;
  name: string;
};

export type CallState =
  | { name: "idle" }
  | { name: "requesting_mic"; target: LiveCallTarget }
  | { name: "mic_denied"; target: LiveCallTarget }
  | { name: "placing"; target: LiveCallTarget }
  | { name: "refused"; target: LiveCallTarget; message: string }
  | { name: "connecting"; target: LiveCallTarget; callId: string; deadlineAt: number }
  | { name: "live"; target: LiveCallTarget; callId: string; startedAt: number }
  | { name: "ended"; target: LiveCallTarget; callId: string }
  | { name: "expired"; target: LiveCallTarget; callId: string }
  | { name: "failed"; target: LiveCallTarget; callId: string | null; message: string };

export type CallEvent =
  | { type: "START"; target: LiveCallTarget }
  | { type: "MIC_GRANTED" }
  | { type: "MIC_DENIED" }
  | { type: "PLACED"; callId: string; deadlineAt: number }
  | { type: "REFUSED"; message: string }
  | { type: "SDK_CALL_STARTED"; at: number }
  | { type: "SDK_CALL_ENDED" }
  | { type: "SDK_ERROR"; message: string }
  | { type: "DEADLINE_PASSED" }
  | { type: "DISMISS" };

export const IDLE: CallState = { name: "idle" };

/**
 * The access token dies 30 seconds after it is minted
 * (docs/verification.md A3). The browser starts this clock when the token
 * arrives, not the server, so a clock skew between the two cannot expire a
 * healthy token early.
 */
export const TOKEN_LIFETIME_MS = 30_000;

/** States with nothing in flight — a new Call may begin, and the bar may be dismissed. */
const SETTLED = ["idle", "mic_denied", "refused", "ended", "expired", "failed"];

function isSettled(state: CallState): boolean {
  return SETTLED.includes(state.name);
}

/**
 * Every transition, and — more importantly — every transition that does not
 * happen. An event arriving in a state that does not expect it is ignored rather
 * than throwing: the SDK is free to emit late, duplicated and out-of-order
 * events, and none of them should be able to move a finished Call.
 */
export function reduceCall(state: CallState, event: CallEvent): CallState {
  switch (event.type) {
    case "START":
      // Only from a settled state, so a double click cannot abandon a live Call.
      return isSettled(state)
        ? { name: "requesting_mic", target: event.target }
        : state;

    case "MIC_GRANTED":
      return state.name === "requesting_mic"
        ? { name: "placing", target: state.target }
        : state;

    case "MIC_DENIED":
      return state.name === "requesting_mic"
        ? { name: "mic_denied", target: state.target }
        : state;

    case "PLACED":
      return state.name === "placing"
        ? {
            name: "connecting",
            target: state.target,
            callId: event.callId,
            deadlineAt: event.deadlineAt,
          }
        : state;

    case "REFUSED":
      return state.name === "placing"
        ? { name: "refused", target: state.target, message: event.message }
        : state;

    case "SDK_CALL_STARTED":
      // Only from `connecting`. A late or duplicated event must not re-open a
      // Call that has already ended.
      return state.name === "connecting"
        ? {
            name: "live",
            target: state.target,
            callId: state.callId,
            startedAt: event.at,
          }
        : state;

    case "SDK_CALL_ENDED":
      // Only a live Call can end. After SDK_ERROR the state is `failed` and must
      // stay failed — the SDK may emit both, in either order.
      return state.name === "live"
        ? { name: "ended", target: state.target, callId: state.callId }
        : state;

    case "SDK_ERROR":
      return state.name === "connecting" || state.name === "live"
        ? {
            name: "failed",
            target: state.target,
            callId: state.callId,
            message: event.message,
          }
        : state;

    case "DEADLINE_PASSED":
      // Ignored once live. The 30-second timer is still running when the Call
      // connects at second three; without this it would kill it at thirty.
      return state.name === "connecting"
        ? { name: "expired", target: state.target, callId: state.callId }
        : state;

    case "DISMISS":
      return isSettled(state) ? IDLE : state;
  }
}
```

- [x] **Step 4: Run the tests**

Run: `npx vitest run lib/calls/machine.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add lib/calls/machine.ts lib/calls/machine.test.ts
git commit -m "Drive every Call state from a reducer, so both failures are testable"
```

---

### Task 4: Placing the Web Call

The orchestration from the spec's Part 1. Retell is injected, so the whole path is exercised without contacting anyone.

**Files:**
- Create: `lib/calls/start-web-call.ts`
- Test: `lib/calls/start-web-call.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// lib/calls/start-web-call.test.ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { provisionUser } from "@/lib/auth/provision-user";
import { startWebCall, type WebCallCreator } from "@/lib/calls/start-web-call";
import { db, schema } from "@/lib/db";

const CLERK_ID = "user_test_start_web_call";
const OTHER_CLERK_ID = "user_test_start_web_call_other";
const STARTS_AT = new Date("2026-09-01T03:30:00.000Z");

let businessId: string;
let appointmentId: string;
let otherAppointmentId: string;

/** A Retell that always succeeds, and records what it was asked for. */
function fakeCreator(): WebCallCreator & { calls: unknown[] } {
  const calls: unknown[] = [];
  const creator = async (params: unknown) => {
    calls.push(params);
    return { call_id: "retell-call-1", access_token: "token-1" };
  };
  return Object.assign(creator as WebCallCreator, { calls });
}

async function cleanupFor(clerkId: string) {
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
      await db.delete(schema.calls).where(eq(schema.calls.appointmentId, appointment.id));
    }
    await db.delete(schema.appointments).where(eq(schema.appointments.businessId, business.id));
    await db.delete(schema.services).where(eq(schema.services.businessId, business.id));
    await db.delete(schema.businesses).where(eq(schema.businesses.id, business.id));
  }
  await db.delete(schema.users).where(eq(schema.users.clerkId, clerkId));
}

async function cleanup() {
  await cleanupFor(CLERK_ID);
  await cleanupFor(OTHER_CLERK_ID);
  await db.delete(schema.retellAgents);
}

async function seedBusiness(clerkId: string, startsAt: Date) {
  const user = await provisionUser(clerkId, `${clerkId}@example.com`);
  const [business] = await db
    .insert(schema.businesses)
    .values({
      userId: user.id,
      name: "Bandra Dental",
      businessType: "clinic",
      timezone: "Asia/Kolkata",
      callQuota: 5,
      callsUsed: 0,
    })
    .returning();
  const [service] = await db
    .insert(schema.services)
    .values({ businessId: business.id, name: "Cleaning", durationMinutes: 30 })
    .returning();
  const [appointment] = await db
    .insert(schema.appointments)
    .values({
      businessId: business.id,
      serviceId: service.id,
      name: "Priya Nair",
      phoneE164: "+12025550142",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
    })
    .returning();

  return { business, appointment };
}

beforeEach(async () => {
  await cleanup();

  await db.insert(schema.retellAgents).values({
    businessType: "clinic",
    llmId: "llm_test",
    agentId: "agent_test_clinic",
  });

  const mine = await seedBusiness(CLERK_ID, STARTS_AT);
  businessId = mine.business.id;
  appointmentId = mine.appointment.id;

  const theirs = await seedBusiness(OTHER_CLERK_ID, new Date("2026-09-02T03:30:00.000Z"));
  otherAppointmentId = theirs.appointment.id;
});

afterEach(cleanup);

async function callsUsed(): Promise<number> {
  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.id, businessId),
  });
  return business!.callsUsed;
}

async function callRows() {
  return db.select().from(schema.calls).where(eq(schema.calls.appointmentId, appointmentId));
}

describe("startWebCall", () => {
  it("returns the access token the browser needs", async () => {
    const result = await startWebCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.accessToken).toBe("token-1");
  });

  it("writes a Call row before Retell is contacted, and decrements", async () => {
    await startWebCall({ businessId, appointmentId, createWebCall: fakeCreator() });

    const [call] = await callRows();
    expect(call.callType).toBe("web");
    expect(call.attempt).toBe(1);
    expect(call.retellCallId).toBe("retell-call-1");
    expect(await callsUsed()).toBe(1);
  });

  it("never writes a Phone Call from this path", async () => {
    // SPEC.md §3 rule 9. There is no branch here that could produce 'phone';
    // this asserts nobody adds one.
    await startWebCall({ businessId, appointmentId, createWebCall: fakeCreator() });

    const [call] = await callRows();
    expect(call.callType).toBe("web");
  });

  it("sends all four dynamic variables, as strings", async () => {
    const creator = fakeCreator();
    await startWebCall({ businessId, appointmentId, createWebCall: creator });

    const params = creator.calls[0] as {
      agent_id: string;
      retell_llm_dynamic_variables: Record<string, string>;
    };
    expect(params.agent_id).toBe("agent_test_clinic");
    expect(Object.keys(params.retell_llm_dynamic_variables).sort()).toEqual([
      "business_name",
      "name",
      "service",
      "time",
    ]);
    for (const value of Object.values(params.retell_llm_dynamic_variables)) {
      expect(typeof value).toBe("string");
    }
  });

  it("moves the Appointment to calling", async () => {
    await startWebCall({ businessId, appointmentId, createWebCall: fakeCreator() });

    const appointment = await db.query.appointments.findFirst({
      where: eq(schema.appointments.id, appointmentId),
    });
    expect(appointment!.status).toBe("calling");
  });

  it("numbers a second Call as attempt 2", async () => {
    await startWebCall({ businessId, appointmentId, createWebCall: fakeCreator() });
    await startWebCall({ businessId, appointmentId, createWebCall: fakeCreator() });

    const attempts = (await callRows()).map((c) => c.attempt).sort();
    expect(attempts).toEqual([1, 2]);
  });

  it("refuses an Appointment belonging to another Business", async () => {
    const result = await startWebCall({
      businessId,
      appointmentId: otherAppointmentId,
      createWebCall: fakeCreator(),
    });

    expect(result).toMatchObject({ ok: false, reason: "not_found" });
    // Nothing spent on a lookup that should never have resolved.
    expect(await callsUsed()).toBe(0);
  });

  it("refuses when the Quota is gone, without contacting Retell", async () => {
    await db
      .update(schema.businesses)
      .set({ callsUsed: 5 })
      .where(eq(schema.businesses.id, businessId));
    const creator = fakeCreator();

    const result = await startWebCall({ businessId, appointmentId, createWebCall: creator });

    expect(result).toMatchObject({ ok: false, reason: "exhausted" });
    expect(creator.calls).toHaveLength(0);
    expect(await callRows()).toHaveLength(0);
  });

  it("refuses before claiming when a variable would be empty", async () => {
    // An unset variable renders literally — Maya would say "curly-curly-name".
    await db
      .update(schema.businesses)
      .set({ name: "   " })
      .where(eq(schema.businesses.id, businessId));
    const creator = fakeCreator();

    const result = await startWebCall({ businessId, appointmentId, createWebCall: creator });

    expect(result).toMatchObject({ ok: false, reason: "invalid_variables" });
    expect(creator.calls).toHaveLength(0);
    // Nothing claimed, so nothing to give back.
    expect(await callsUsed()).toBe(0);
  });
});

describe("when Retell fails", () => {
  const throwingCreator: WebCallCreator = async () => {
    throw new Error("503 from Retell");
  };

  it("gives the Quota back, because the failure is ours and provable", async () => {
    const result = await startWebCall({
      businessId,
      appointmentId,
      createWebCall: throwingCreator,
    });

    expect(result).toMatchObject({ ok: false, reason: "retell_failed" });
    expect(await callsUsed()).toBe(0);
  });

  it("keeps the Call row, marked failed, so the attempt is not erased", async () => {
    await startWebCall({ businessId, appointmentId, createWebCall: throwingCreator });

    const [call] = await callRows();
    expect(call.status).toBe("failed");
    expect(call.disconnectReason).toBe("create_web_call_failed");
  });

  it("leaves the Appointment where it was", async () => {
    await startWebCall({ businessId, appointmentId, createWebCall: throwingCreator });

    const appointment = await db.query.appointments.findFirst({
      where: eq(schema.appointments.id, appointmentId),
    });
    expect(appointment!.status).toBe("pending");
  });
});
```

- [x] **Step 2: Run it to make sure it fails**

Run: `npx vitest run lib/calls/start-web-call.test.ts`
Expected: FAIL — cannot resolve `@/lib/calls/start-web-call`.

- [x] **Step 3: Write the implementation**

```ts
// lib/calls/start-web-call.ts
import { and, count, eq } from "drizzle-orm";

import {
  buildDynamicVariables,
  type DynamicVariables,
  validateDynamicVariables,
} from "@/lib/calls/dynamic-variables";
import { claimCallQuota, releaseCallQuota } from "@/lib/calls/quota";
import { db, schema } from "@/lib/db";
import { agentIdFor } from "@/lib/retell/agents";
import { retellClient } from "@/lib/retell/client";

/*
  Placing a Web Call (SPEC.md §7, docs/verification.md A3).

  The order is the design. Everything that can refuse does so before anything is
  spent: the Appointment is resolved, the dynamic variables are validated, and
  only then is the Quota claimed and a Call row written — and only then is Retell
  contacted.

  The microphone is NOT requested here. That happens in the browser before this
  function is ever called, which is what makes a declined prompt cost nothing.
  See components/calls/live-call-provider.tsx.
*/

/**
 * The half of Retell this file uses, as a function.
 *
 * Injected rather than imported so the whole orchestration — including the
 * compensating write when Retell fails — is exercised by tests that contact
 * nobody. SPEC.md §3 rule 11: no automated test places a real Call.
 */
export type WebCallCreator = (params: {
  agent_id: string;
  retell_llm_dynamic_variables: DynamicVariables;
  metadata: Record<string, string>;
}) => Promise<{ call_id: string; access_token: string }>;

/** The real one. `metadata` is echoed on every webhook, which #13 relies on. */
export const createWebCallWithRetell: WebCallCreator = async (params) => {
  const response = await retellClient().call.createWebCall(params);
  return { call_id: response.call_id, access_token: response.access_token };
};

export type StartWebCallResult =
  | { ok: true; callId: string; accessToken: string }
  | {
      ok: false;
      reason: "not_found" | "exhausted" | "invalid_variables" | "retell_failed";
      message: string;
    };

const MESSAGES = {
  not_found: "That appointment no longer exists.",
  exhausted: "You've used all your calls.",
  invalid_variables:
    "This appointment is missing details Maya needs. Check the business name, the customer's name and the service.",
  retell_failed: "Couldn't reach the calling service. Your call was not used.",
} as const;

export async function startWebCall({
  businessId,
  appointmentId,
  createWebCall = createWebCallWithRetell,
}: {
  businessId: string;
  appointmentId: string;
  createWebCall?: WebCallCreator;
}): Promise<StartWebCallResult> {
  /*
    Scoped to the Business in the WHERE clause, not checked after the read. This
    is the cross-tenant guard: another account's Appointment does not resolve,
    so there is no branch that could act on one.
  */
  const [row] = await db
    .select({
      appointmentName: schema.appointments.name,
      startsAt: schema.appointments.startsAt,
      serviceName: schema.services.name,
      businessName: schema.businesses.name,
      businessType: schema.businesses.businessType,
      timezone: schema.businesses.timezone,
    })
    .from(schema.appointments)
    .innerJoin(schema.services, eq(schema.appointments.serviceId, schema.services.id))
    .innerJoin(schema.businesses, eq(schema.appointments.businessId, schema.businesses.id))
    .where(
      and(
        eq(schema.appointments.id, appointmentId),
        eq(schema.appointments.businessId, businessId),
      ),
    )
    .limit(1);

  if (!row) return { ok: false, reason: "not_found", message: MESSAGES.not_found };

  /*
    Validated before the Quota is touched. Retell renders an unset variable
    literally, so this is the difference between refusing a Call and Maya saying
    "curly-curly-name" to a customer (docs/verification.md A5).
  */
  const variables = buildDynamicVariables({
    businessName: row.businessName,
    name: row.appointmentName,
    serviceName: row.serviceName,
    startsAt: row.startsAt,
    timezone: row.timezone,
  });
  if (!validateDynamicVariables(variables).ok) {
    return {
      ok: false,
      reason: "invalid_variables",
      message: MESSAGES.invalid_variables,
    };
  }

  const agentId = await agentIdFor(row.businessType);

  // A second Call is a second row, numbered from the ones already there.
  const [{ existing }] = await db
    .select({ existing: count() })
    .from(schema.calls)
    .where(eq(schema.calls.appointmentId, appointmentId));

  /*
    The claim and the Call row land together or not at all. A claimed Call with
    no row charges someone for nothing; a row with no claim gives away a Call.
  */
  let callId: string;
  try {
    callId = await db.transaction(async (tx) => {
      const claim = await claimCallQuota(tx, businessId);
      if (!claim.ok) throw new QuotaExhausted();

      const [call] = await tx
        .insert(schema.calls)
        .values({
          appointmentId,
          // SPEC.md §3 rule 9: this path places Web Calls and nothing else.
          callType: "web",
          attempt: existing + 1,
          status: "queued",
        })
        .returning({ id: schema.calls.id });

      return call.id;
    });
  } catch (error) {
    if (error instanceof QuotaExhausted) {
      return { ok: false, reason: "exhausted", message: MESSAGES.exhausted };
    }
    throw error;
  }

  /*
    Outside the transaction, because it is a network call — holding a row lock
    across an HTTP round trip would block every other Call the account places.

    So a failure here cannot roll back. It is compensated instead: the row is
    marked failed and the Quota is handed back. This is the only refund in the
    system, and it is the one failure we can prove on the server.
  */
  try {
    const response = await createWebCall({
      agent_id: agentId,
      retell_llm_dynamic_variables: variables,
      // Echoed back on every webhook, so #13 can recover the Call even if a
      // webhook arrives before this row is visible to it.
      metadata: { call_id: callId, appointment_id: appointmentId },
    });

    await db
      .update(schema.calls)
      .set({ retellCallId: response.call_id })
      .where(eq(schema.calls.id, callId));

    await db
      .update(schema.appointments)
      .set({ status: "calling" })
      .where(eq(schema.appointments.id, appointmentId));

    return { ok: true, callId, accessToken: response.access_token };
  } catch {
    await db
      .update(schema.calls)
      .set({ status: "failed", disconnectReason: "create_web_call_failed" })
      .where(eq(schema.calls.id, callId));
    await releaseCallQuota(db, businessId);

    return { ok: false, reason: "retell_failed", message: MESSAGES.retell_failed };
  }
}

/** Rolls the transaction back without making an exhausted Quota look like a crash. */
class QuotaExhausted extends Error {}
```

- [x] **Step 4: Run the tests**

Run: `npx vitest run lib/calls/start-web-call.test.ts`
Expected: PASS. If `retellClient().call.createWebCall` does not exist under that name, `npm run typecheck` will say so — fix the wrapper to match the installed SDK and leave `WebCallCreator` alone.

- [x] **Step 5: Commit**

```bash
git add lib/calls/start-web-call.ts lib/calls/start-web-call.test.ts
git commit -m "Place the Web Call, refusing everything it can before spending anything"
```

---

### Task 5: Which Calls count as live

Acceptance criterion 6's data half. The staleness window is the answer to "the tab closed mid-Call".

**Files:**
- Create: `lib/business/active-calls.ts`
- Test: `lib/business/active-calls.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// lib/business/active-calls.test.ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { provisionUser } from "@/lib/auth/provision-user";
import {
  countActiveCalls,
  liveCallAppointmentIds,
  LIVE_CALL_STALENESS_MS,
} from "@/lib/business/active-calls";
import { db, schema } from "@/lib/db";
import type { CallStatus } from "@/lib/db/schema";

const CLERK_ID = "user_test_active_calls";
const OTHER_CLERK_ID = "user_test_active_calls_other";
const NOW = new Date("2026-09-01T10:00:00.000Z");

let businessId: string;
let appointmentId: string;
let otherBusinessId: string;
let otherAppointmentId: string;

async function cleanupFor(clerkId: string) {
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
      await db.delete(schema.calls).where(eq(schema.calls.appointmentId, appointment.id));
    }
    await db.delete(schema.appointments).where(eq(schema.appointments.businessId, business.id));
    await db.delete(schema.services).where(eq(schema.services.businessId, business.id));
    await db.delete(schema.businesses).where(eq(schema.businesses.id, business.id));
  }
  await db.delete(schema.users).where(eq(schema.users.clerkId, clerkId));
}

async function cleanup() {
  await cleanupFor(CLERK_ID);
  await cleanupFor(OTHER_CLERK_ID);
}

async function seed(clerkId: string) {
  const user = await provisionUser(clerkId, `${clerkId}@example.com`);
  const [business] = await db
    .insert(schema.businesses)
    .values({
      userId: user.id,
      name: "Active Calls Clinic",
      businessType: "clinic",
      timezone: "Asia/Kolkata",
    })
    .returning();
  const [service] = await db
    .insert(schema.services)
    .values({ businessId: business.id, name: "Cleaning", durationMinutes: 30 })
    .returning();
  const [appointment] = await db
    .insert(schema.appointments)
    .values({
      businessId: business.id,
      serviceId: service.id,
      name: "Priya Nair",
      phoneE164: "+12025550142",
      startsAt: new Date("2026-09-05T03:30:00.000Z"),
      endsAt: new Date("2026-09-05T04:00:00.000Z"),
    })
    .returning();
  return { businessId: business.id, appointmentId: appointment.id };
}

async function addCall(
  targetAppointmentId: string,
  status: CallStatus,
  startedAt: Date | null,
) {
  await db.insert(schema.calls).values({
    appointmentId: targetAppointmentId,
    callType: "web",
    status,
    startedAt,
  });
}

beforeEach(async () => {
  await cleanup();
  ({ businessId, appointmentId } = await seed(CLERK_ID));
  ({ businessId: otherBusinessId, appointmentId: otherAppointmentId } =
    await seed(OTHER_CLERK_ID));
});

afterEach(cleanup);

describe("countActiveCalls", () => {
  it("counts a Call that started a moment ago", async () => {
    await addCall(appointmentId, "in_progress", new Date(NOW.getTime() - 10_000));

    expect(await countActiveCalls(businessId, NOW)).toBe(1);
  });

  it("ignores a Call that is older than a Call can be", async () => {
    // The tab closed mid-Call, so nothing ever reported the end. The 120s cap
    // means this Call cannot still be running; the dot must not pulse forever.
    await addCall(appointmentId, "in_progress", new Date(NOW.getTime() - LIVE_CALL_STALENESS_MS - 1));

    expect(await countActiveCalls(businessId, NOW)).toBe(0);
  });

  it("ignores a queued Call, which has not connected", async () => {
    await addCall(appointmentId, "queued", null);

    expect(await countActiveCalls(businessId, NOW)).toBe(0);
  });

  it("ignores a completed Call", async () => {
    await addCall(appointmentId, "completed", new Date(NOW.getTime() - 10_000));

    expect(await countActiveCalls(businessId, NOW)).toBe(0);
  });

  it("never counts another Business's Call", async () => {
    await addCall(otherAppointmentId, "in_progress", new Date(NOW.getTime() - 10_000));

    expect(await countActiveCalls(businessId, NOW)).toBe(0);
    expect(await countActiveCalls(otherBusinessId, NOW)).toBe(1);
  });
});

describe("liveCallAppointmentIds", () => {
  it("names the Appointment whose row should shimmer", async () => {
    await addCall(appointmentId, "in_progress", new Date(NOW.getTime() - 10_000));

    expect(await liveCallAppointmentIds(businessId, NOW)).toEqual(new Set([appointmentId]));
  });

  it("is empty when nothing is live", async () => {
    expect(await liveCallAppointmentIds(businessId, NOW)).toEqual(new Set());
  });
});
```

- [x] **Step 2: Run it to make sure it fails**

Run: `npx vitest run lib/business/active-calls.test.ts`
Expected: FAIL — cannot resolve `@/lib/business/active-calls`.

- [x] **Step 3: Write the implementation**

```ts
// lib/business/active-calls.ts
import { and, eq, gt } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/*
  Which Calls are live right now — the topbar's pulsing dot (SPEC.md §11.1) and
  the shimmer on the row being called (§11.2).

  Both read `in_progress` AND a recent `started_at`, and the second half is what
  makes this correct. Until #13's webhook receiver exists, the browser is the only
  thing that reports a Call ending. A closed tab reports nothing, so the row stays
  `in_progress` forever and the dot would pulse for the life of the account.

  A Call cannot outlive `max_call_duration_ms` (SPEC.md §7), so anything older
  than that plus slack is not live whatever the column says. No background job, no
  cleanup process, nothing to schedule — the staleness is computed at read time.
*/

/** The 120s cap (SPEC.md §7) plus a minute of slack. */
export const LIVE_CALL_STALENESS_MS = 180_000;

function liveSince(now: Date): Date {
  return new Date(now.getTime() - LIVE_CALL_STALENESS_MS);
}

/** The Calls this Business has in progress. `now` is injected so tests do not depend on the clock. */
export async function countActiveCalls(
  businessId: string,
  now: Date = new Date(),
): Promise<number> {
  return (await liveCalls(businessId, now)).length;
}

/** The Appointments whose rows should shimmer. */
export async function liveCallAppointmentIds(
  businessId: string,
  now: Date = new Date(),
): Promise<Set<string>> {
  return new Set((await liveCalls(businessId, now)).map((call) => call.appointmentId));
}

async function liveCalls(businessId: string, now: Date) {
  return db
    .select({ appointmentId: schema.calls.appointmentId })
    .from(schema.calls)
    .innerJoin(schema.appointments, eq(schema.calls.appointmentId, schema.appointments.id))
    .where(
      and(
        eq(schema.appointments.businessId, businessId),
        eq(schema.calls.status, "in_progress"),
        gt(schema.calls.startedAt, liveSince(now)),
      ),
    );
}
```

- [x] **Step 4: Run the tests**

Run: `npx vitest run lib/business/active-calls.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add lib/business/active-calls.ts lib/business/active-calls.test.ts
git commit -m "Count live Calls, and stop counting one whose browser went away"
```

---

### Task 6: `isCalling` on the Appointment row

**Files:**
- Modify: `lib/business/list-appointments.ts`
- Test: `lib/business/list-appointments.test.ts`

- [x] **Step 1: Add the failing test**

Append to `lib/business/list-appointments.test.ts`. Read the file first — reuse the seeding helpers already there rather than adding new ones.

```ts
describe("the row being called", () => {
  it("marks an Appointment with a live Call", async () => {
    // `businessId` and an appointment id come from the file's existing setup.
    const [appointment] = await listAppointments(businessId);
    await db.insert(schema.calls).values({
      appointmentId: appointment.id,
      callType: "web",
      status: "in_progress",
      startedAt: new Date(),
    });

    const rows = await listAppointments(businessId);
    expect(rows.find((r) => r.id === appointment.id)!.isCalling).toBe(true);
  });

  it("leaves every other row alone", async () => {
    const rows = await listAppointments(businessId);
    expect(rows.every((row) => row.isCalling === false)).toBe(true);
  });
});
```

- [x] **Step 2: Run it to make sure it fails**

Run: `npx vitest run lib/business/list-appointments.test.ts`
Expected: FAIL — `isCalling` does not exist on `AppointmentRow`.

- [x] **Step 3: Implement**

In `lib/business/list-appointments.ts`, add to `AppointmentRow`:

```ts
  /** True while a Call for this Appointment is live — the row shimmers (§11.2). */
  isCalling: boolean;
```

Add the import:

```ts
import { liveCallAppointmentIds } from "@/lib/business/active-calls";
```

Load the live ids alongside the Calls query:

```ts
  const live = await liveCallAppointmentIds(businessId);
```

And in the final `map`, add:

```ts
      isCalling: live.has(appointment.id),
```

- [x] **Step 4: Run the tests**

Run: `npx vitest run lib/business/list-appointments.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add lib/business/list-appointments.ts lib/business/list-appointments.test.ts
git commit -m "Mark the row whose Call is live, for the shimmer to hang on"
```

---

### Task 7: The four Server Actions

**Files:**
- Create: `app/(app)/calls/actions.ts`

There is no unit test here: every function is `requireBusiness()` plus one scoped write, and both halves are already covered — `requireBusiness` by its own tests, the writes by Tasks 4 and 5. The behaviour that could break is the wiring, which Task 11 verifies in the browser.

- [x] **Step 1: Write the actions**

```ts
// app/(app)/calls/actions.ts
"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { startWebCall } from "@/lib/calls/start-web-call";
import { requireBusiness } from "@/lib/business/require-business";
import { db, schema } from "@/lib/db";

/*
  The Web Call's Server Actions.

  Three rules, the same ones app/(app)/settings/actions.ts documents.
  `requireBusiness()` comes first in every one, because a Server Action is a POST
  anyone can send and rendering a button on an authenticated screen is not a
  security boundary. Nothing closes over anything. A refusal comes back as a
  value rather than a throw, because SPEC.md §11.4 wants inline persistent UI for
  anything requiring action.

  A fourth rule is specific to this file: every write is scoped to the caller's
  Business inside the statement, never by a read followed by a check. `callId` is
  supplied by the browser, so the join to `appointments` is the guard.

  On trusting the browser at all. Until #13's webhook receiver exists, the page
  is the only thing that knows a Call started or ended. A forged POST here can
  only move a Call the account already owns and already paid for — the worst
  available outcome is an account lying to its own dashboard. No Quota is
  returned by any of the three reporters, so there is nothing to farm. #13's
  webhook is the authoritative writer and overwrites all of it.
*/

export type StartCallState =
  | { ok: true; callId: string; accessToken: string }
  | { ok: false; message: string };

export async function startWebCallAction(
  appointmentId: string,
): Promise<StartCallState> {
  const { business } = await requireBusiness();

  const result = await startWebCall({ businessId: business.id, appointmentId });

  // The Quota meter and the row's status both moved.
  revalidatePath("/");

  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true, callId: result.callId, accessToken: result.accessToken };
}

export async function reportCallStartedAction(callId: string): Promise<void> {
  const { business } = await requireBusiness();

  await db
    .update(schema.calls)
    .set({ status: "in_progress", startedAt: new Date() })
    .where(and(eq(schema.calls.id, callId), ownedBy(business.id)));

  revalidatePath("/");
}

export async function reportCallEndedAction(callId: string): Promise<void> {
  const { business } = await requireBusiness();

  /*
    The duration is computed here, from started_at, rather than taken from the
    browser. There is no reason to accept a number we already hold.
  */
  const [call] = await db
    .update(schema.calls)
    .set({
      status: "completed",
      endedAt: new Date(),
      durationSeconds: sql`GREATEST(EXTRACT(EPOCH FROM (now() - ${schema.calls.startedAt}))::int, 0)`,
    })
    .where(and(eq(schema.calls.id, callId), ownedBy(business.id)))
    .returning({ appointmentId: schema.calls.appointmentId });

  if (call) await releaseAppointment(call.appointmentId);

  revalidatePath("/");
}

export async function reportCallFailedAction(
  callId: string,
  disconnectReason: string,
): Promise<void> {
  const { business } = await requireBusiness();

  const [call] = await db
    .update(schema.calls)
    .set({ status: "failed", endedAt: new Date(), disconnectReason })
    .where(and(eq(schema.calls.id, callId), ownedBy(business.id)))
    .returning({ appointmentId: schema.calls.appointmentId });

  if (call) await releaseAppointment(call.appointmentId);

  revalidatePath("/");
}

/** The cross-tenant guard: this Call hangs off an Appointment of this Business. */
function ownedBy(businessId: string) {
  return sql`${schema.calls.appointmentId} IN (
    SELECT ${schema.appointments.id} FROM ${schema.appointments}
     WHERE ${schema.appointments.businessId} = ${businessId}
  )`;
}

/**
 * Returns the Appointment to `pending` once its Call is over.
 *
 * **Only if it is still `calling`.** Nothing decided this Appointment's outcome —
 * no Tool committed, because #10 has not built the Tool endpoints yet — so
 * `pending` is where it genuinely is. Leaving it at `calling` would show a
 * permanently-calling row; claiming `confirmed` would be the small version of
 * SPEC.md §3 rule 7.
 *
 * The condition is not decoration. Once #12's Tools land, a Tool may write
 * `confirmed` or `rescheduled` mid-Call, and this must not overwrite it. The Tool
 * wins (SPEC.md §9 step 3).
 */
async function releaseAppointment(appointmentId: string): Promise<void> {
  await db
    .update(schema.appointments)
    .set({ status: "pending" })
    .where(
      and(
        eq(schema.appointments.id, appointmentId),
        eq(schema.appointments.status, "calling"),
      ),
    );
}
```

- [x] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [x] **Step 3: Commit**

```bash
git add "app/(app)/calls/actions.ts"
git commit -m "Add the Call's Server Actions, each scoped to its own Business"
```

---

### Task 8: The provider — the microphone, the SDK, the timer

**Files:**
- Create: `components/calls/live-call-provider.tsx`

- [x] **Step 1: Write the provider**

```tsx
// components/calls/live-call-provider.tsx
"use client"

import { useRouter } from "next/navigation"
import * as React from "react"

import {
  reportCallEndedAction,
  reportCallFailedAction,
  reportCallStartedAction,
  startWebCallAction,
} from "@/app/(app)/calls/actions"
import {
  IDLE,
  reduceCall,
  TOKEN_LIFETIME_MS,
  type CallState,
  type LiveCallTarget,
} from "@/lib/calls/machine"

/**
 * Owns the one Call that can be in flight, for the whole app shell.
 *
 * Three things live here because they must not be duplicated: the microphone
 * request, the `RetellWebClient` instance, and the 30-second deadline. Both
 * buttons that can start a Call — the Quick Call card and every table row — go
 * through this, so there is one implementation of every state.
 *
 * It decides nothing. `lib/calls/machine.ts` holds the transitions; this wires
 * events to `dispatch` and performs the side effects.
 */

type LiveCall = {
  state: CallState
  start: (target: LiveCallTarget) => void
  hangUp: () => void
  dismiss: () => void
}

const LiveCallContext = React.createContext<LiveCall | null>(null)

export function useLiveCall(): LiveCall {
  const context = React.useContext(LiveCallContext)
  if (!context) {
    throw new Error("useLiveCall must be used inside <LiveCallProvider>")
  }
  return context
}

/** How often the page re-reads while a Call is live (SPEC.md §11.3). */
const LIVE_REFRESH_MS = 5_000

export function LiveCallProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = React.useReducer(reduceCall, IDLE)
  const router = useRouter()

  // The SDK is browser-only, so it is imported on demand rather than at module
  // scope — a static import would pull it into the server bundle.
  const clientRef = React.useRef<{ startCall: (o: { accessToken: string }) => Promise<void>; stopCall: () => void } | null>(null)

  /*
    The current state, readable from inside SDK callbacks.

    The SDK's listeners are registered once and close over whatever `state` was
    at that moment. Without this ref a `call_ended` handler would report the Call
    id from three states ago.
  */
  const stateRef = React.useRef(state)
  React.useEffect(() => {
    stateRef.current = state
  }, [state])

  /* Refresh on every state change, and every 5s while live (SPEC.md §11.3). */
  React.useEffect(() => {
    router.refresh()
    if (state.name !== "live") return

    const interval = setInterval(() => router.refresh(), LIVE_REFRESH_MS)
    return () => clearInterval(interval)
  }, [state.name, router])

  /* The 30-second deadline. Cleared the moment the state leaves `connecting`. */
  React.useEffect(() => {
    if (state.name !== "connecting") return

    const remaining = Math.max(0, state.deadlineAt - Date.now())
    const timer = setTimeout(() => {
      clientRef.current?.stopCall()
      dispatch({ type: "DEADLINE_PASSED" })
      // Retell's own reason for this, so #13's webhook agrees rather than
      // conflicts when it writes the same row (docs/verification.md A3, A9).
      void reportCallFailedAction(state.callId, "error_user_not_joined")
    }, remaining)

    return () => clearTimeout(timer)
  }, [state])

  const start = React.useCallback(
    async (target: LiveCallTarget) => {
      dispatch({ type: "START", target })

      /*
        The microphone first, before anything is written or spent. A decline
        here costs the account nothing: no Call row, no Retell contact, no
        Quota. That ordering is what lets the refund rule stay strict.
      */
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        // We only wanted the answer. The SDK opens its own stream.
        stream.getTracks().forEach((track) => track.stop())
      } catch {
        dispatch({ type: "MIC_DENIED" })
        return
      }
      dispatch({ type: "MIC_GRANTED" })

      const result = await startWebCallAction(target.appointmentId)
      if (!result.ok) {
        dispatch({ type: "REFUSED", message: result.message })
        return
      }

      // The deadline is started here, not on the server, so a clock skew
      // between the two cannot expire a healthy token early.
      dispatch({
        type: "PLACED",
        callId: result.callId,
        deadlineAt: Date.now() + TOKEN_LIFETIME_MS,
      })

      try {
        const { RetellWebClient } = await import("retell-client-js-sdk")
        const client = new RetellWebClient()
        clientRef.current = client

        client.on("call_started", () => {
          dispatch({ type: "SDK_CALL_STARTED", at: Date.now() })
          void reportCallStartedAction(result.callId)
        })

        client.on("call_ended", () => {
          const current = stateRef.current
          dispatch({ type: "SDK_CALL_ENDED" })
          // Only a Call that was actually live has ended. After an error the
          // machine is already `failed` and the row is already written.
          if (current.name === "live") void reportCallEndedAction(result.callId)
        })

        client.on("error", (error: unknown) => {
          const message = error instanceof Error ? error.message : "The call failed."
          client.stopCall()
          dispatch({ type: "SDK_ERROR", message })
          void reportCallFailedAction(result.callId, "error_retell")
        })

        await client.startCall({ accessToken: result.accessToken })
      } catch (error) {
        const message = error instanceof Error ? error.message : "The call failed."
        dispatch({ type: "SDK_ERROR", message })
        void reportCallFailedAction(result.callId, "error_retell")
      }
    },
    [],
  )

  const hangUp = React.useCallback(() => {
    clientRef.current?.stopCall()
    // No dispatch here. `stopCall` makes the SDK emit `call_ended`, and letting
    // that one path write the row keeps hanging up and the far end hanging up
    // identical.
  }, [])

  const dismiss = React.useCallback(() => dispatch({ type: "DISMISS" }), [])

  const value = React.useMemo(
    () => ({ state, start: (t: LiveCallTarget) => void start(t), hangUp, dismiss }),
    [state, start, hangUp, dismiss],
  )

  return <LiveCallContext.Provider value={value}>{children}</LiveCallContext.Provider>
}
```

- [x] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors. If the SDK's `on` signature disagrees, adjust the handler types to match the installed package — do not widen `clientRef` to `any`.

- [x] **Step 3: Commit**

```bash
git add components/calls/live-call-provider.tsx
git commit -m "Ask for the microphone before anything can be spent on the answer"
```

---

### Task 9: The sticky bar — every designed state

Acceptance criterion 5's visible half.

**Files:**
- Create: `components/calls/live-call-bar.tsx`
- Modify: `app/globals.css`

- [x] **Step 1: Add the shimmer keyframes**

In `app/globals.css`, inside the `@theme` block, after `--animate-live-pulse` and its keyframes:

```css
  /* The second signature animation (§11.2): the row of the Appointment being called. */
  --animate-row-shimmer: row-shimmer 2s ease-in-out infinite;

  @keyframes row-shimmer {
    0%,
    100% {
      background-color: color-mix(in oklab, var(--color-accent) 6%, transparent);
    }
    50% {
      background-color: color-mix(in oklab, var(--color-accent) 14%, transparent);
    }
  }
```

`prefers-reduced-motion` is already handled by the global rule at the bottom of the file — it collapses every animation, so this needs nothing of its own.

- [x] **Step 2: Write the bar**

```tsx
// components/calls/live-call-bar.tsx
"use client"

import { Loader2, MicOff, PhoneOff, TriangleAlert } from "lucide-react"
import * as React from "react"

import { useLiveCall } from "@/components/calls/live-call-provider"
import { Button } from "@/components/ui/button"

/**
 * The Call on screen, under the topbar (SPEC.md §11.3, §11.4).
 *
 * A bar rather than a modal, deliberately. SPEC.md §16 step 5 is "cut to the
 * dashboard before hanging up" — the Appointments table has to stay visible
 * while Maya is still talking, and a dialog would cover the one row the demo is
 * about.
 *
 * One rendering of every state, whichever button started the Call. Everything
 * here is inline and persistent rather than a toast, per §11.4: each failure
 * state names what happened and offers the action that fixes it.
 */
export function LiveCallBar() {
  const { state, hangUp, dismiss } = useLiveCall()

  if (state.name === "idle") return null

  return (
    <div className="border-b border-line bg-surface px-4 py-2 lg:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-table">
        <Body />
      </div>
    </div>
  )

  function Body() {
    switch (state.name) {
      case "requesting_mic":
        return (
          <Status icon={<Loader2 className="animate-spin" aria-hidden />}>
            Waiting for microphone permission…
          </Status>
        )

      case "mic_denied":
        return (
          <>
            <Status icon={<MicOff className="text-attention" aria-hidden />}>
              Callzie needs your microphone to run the call. Allow it in your
              browser&rsquo;s address bar, then try again.
            </Status>
            {/* The reassurance is the point: the strict refund rule is only fair
                because this path genuinely costs nothing. */}
            <span className="text-text-muted">No call was used.</span>
            <Dismiss label="Dismiss" />
          </>
        )

      case "placing":
      case "connecting":
        return (
          <Status icon={<Loader2 className="animate-spin" aria-hidden />}>
            Connecting to Maya…
          </Status>
        )

      case "refused":
        return (
          <>
            <Status icon={<TriangleAlert className="text-attention" aria-hidden />}>
              {state.message}
            </Status>
            <Dismiss label="Dismiss" />
          </>
        )

      case "live":
        return (
          <>
            <span className="flex items-center gap-2 text-text">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full bg-accent animate-live-pulse"
              />
              Live with {state.target.name}
            </span>
            <Elapsed since={state.startedAt} />
            <span className="ms-auto">
              <Button size="sm" variant="destructive" onClick={hangUp}>
                <PhoneOff aria-hidden />
                Hang up
              </Button>
            </span>
          </>
        )

      case "ended":
        return (
          <>
            <Status>Call with {state.target.name} ended.</Status>
            <Dismiss label="Dismiss" />
          </>
        )

      case "expired":
        return (
          <>
            <Status icon={<TriangleAlert className="text-attention" aria-hidden />}>
              The call didn&rsquo;t connect in time. The line has to be joined
              within 30 seconds of being opened.
            </Status>
            <Dismiss label="Dismiss" />
          </>
        )

      case "failed":
        return (
          <>
            <Status icon={<TriangleAlert className="text-declined" aria-hidden />}>
              {state.message}
            </Status>
            <Dismiss label="Dismiss" />
          </>
        )
    }
  }

  function Dismiss({ label }: { label: string }) {
    return (
      <span className="ms-auto">
        <Button size="sm" variant="outline" onClick={dismiss}>
          {label}
        </Button>
      </span>
    )
  }
}

function Status({
  icon,
  children,
}: {
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  // A live region so a state change is announced rather than only seen.
  return (
    <span className="flex items-center gap-2 text-text-muted" role="status">
      {icon}
      {children}
    </span>
  )
}

/** How long the Call has been running. Mono, per §11.2's list of faces. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(interval)
  }, [])

  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  const label = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`

  return <span className="font-mono text-text-muted">{label}</span>
}
```

- [x] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [x] **Step 4: Commit**

```bash
git add components/calls/live-call-bar.tsx app/globals.css
git commit -m "Render every Call state in a bar that never covers the table"
```

---

### Task 10: The two buttons, the shimmer, and the shell

**Files:**
- Create: `components/calls/call-now-button.tsx`
- Modify: `app/(app)/layout.tsx`
- Modify: `app/(app)/page.tsx`
- Modify: `app/(app)/actions.ts`
- Modify: `components/overview/quick-call-card.tsx`
- Modify: `components/overview/appointments-table.tsx`

- [x] **Step 1: Write the row button**

```tsx
// components/calls/call-now-button.tsx
"use client"

import { Phone } from "lucide-react"

import { useLiveCall } from "@/components/calls/live-call-provider"
import { Button } from "@/components/ui/button"

/**
 * "Call now" on one Appointment's row (SPEC.md §11.3).
 *
 * Disabled while any Call is in flight, because there is one bar and one Call.
 * The `title` says why — a disabled control with no explanation is worse than no
 * control.
 */
export function CallNowButton({
  appointmentId,
  name,
}: {
  appointmentId: string
  name: string
}) {
  const { state, start } = useLiveCall()

  const busy = ["requesting_mic", "placing", "connecting", "live"].includes(state.name)

  return (
    <Button
      size="sm"
      disabled={busy}
      title={busy ? "Finish the call in progress first" : undefined}
      onClick={() => start({ appointmentId, name })}
    >
      <Phone aria-hidden />
      Call now
      <span className="sr-only"> — {name}</span>
    </Button>
  )
}
```

- [x] **Step 2: Wire the shell**

In `app/(app)/layout.tsx`: delete the `ACTIVE_CALLS` constant and its TODO comment, add the imports, and wrap the content.

```tsx
import { LiveCallBar } from "@/components/calls/live-call-bar"
import { LiveCallProvider } from "@/components/calls/live-call-provider"
import { countActiveCalls } from "@/lib/business/active-calls"
```

Then inside the component, after `const quota = businessQuota(business)`:

```tsx
  const activeCalls = await countActiveCalls(business.id)
```

And the returned tree becomes — note `children` stays a Server Component because it is passed through as a prop:

```tsx
    <LiveCallProvider>
      <div className="flex min-h-svh">
        <Sidebar
          quota={quota}
          collapsible
          className="hidden shrink-0 border-r border-line md:sticky md:top-0 md:flex md:h-svh md:w-16 lg:w-60"
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar
            mobileNav={<MobileNav quota={quota} />}
            liveIndicator={<LiveIndicator activeCalls={activeCalls} />}
            userButton={<UserButtonSlot />}
          />
          <LiveCallBar />
          <main className="flex-1 px-4 py-6 lg:px-6">{children}</main>
        </div>
      </div>
    </LiveCallProvider>
```

- [x] **Step 3: Return the new Appointment's id from quick-add**

In `lib/appointments/quick-add-input.ts`, add `id` to the `added` shape:

```ts
  added?: { id: string; name: string; startsAt: string }
```

In `app/(app)/actions.ts`, in `addAppointmentAction`'s success return:

```ts
    added: {
      id: result.appointment.id,
      name: result.appointment.name,
      startsAt: formatInZone(result.appointment.startsAt, business.timezone),
    },
```

- [x] **Step 4: Make the Quick Call card dial**

In `components/overview/quick-call-card.tsx`:

Add the import:

```tsx
import { useLiveCall } from "@/components/calls/live-call-provider"
```

Inside `QuickCallCard`, add:

```tsx
  const { start } = useLiveCall()
```

Extend the existing `React.useEffect` that runs on `state.added` so it also dials. The effect already resets the form and refetches the Slots; the dial chains onto the same submit, which is what the file's own comment has said since #7:

```tsx
  React.useEffect(() => {
    if (!state.added) return
    formRef.current?.reset()
    loadSlots(serviceId)
    start({ appointmentId: state.added.id, name: state.added.name })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.added])
```

Change the button's words — the whole point of the ticket for this card:

```tsx
    <Button type="submit" disabled={pending}>
      {pending && <Loader2 className="animate-spin" aria-hidden />}
      {pending ? "Starting…" : "Call now"}
    </Button>
```

Update the component's doc comment: the paragraph explaining why it says "Add appointment" is now false. Replace it with why it says "Call now" — one submit adds the Appointment and starts the Call, which is what §11.3 asks that card to be.

- [x] **Step 5: Add the row action and the shimmer**

In `components/overview/appointments-table.tsx`:

```tsx
import { CallNowButton } from "@/components/calls/call-now-button"
```

Add a header cell after `Last call`:

```tsx
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
```

Give the row the shimmer and the button:

```tsx
              <tr
                key={appointment.id}
                className={cn(
                  "border-b border-line last:border-b-0",
                  appointment.isCalling && "animate-row-shimmer",
                )}
              >
```

and, as the last cell in the row:

```tsx
                <Td>
                  <CallNowButton
                    appointmentId={appointment.id}
                    name={appointment.name}
                  />
                </Td>
```

Update the empty-row `colSpan={7}` to `colSpan={8}`.

In the mobile `<li>`, add the same shimmer class and put the button at the end of the card:

```tsx
            <li
              key={appointment.id}
              className={cn(
                "flex flex-col gap-2 border-b border-line p-4 last:border-b-0",
                appointment.isCalling && "animate-row-shimmer",
              )}
            >
```

```tsx
              <div className="pt-1">
                <CallNowButton
                  appointmentId={appointment.id}
                  name={appointment.name}
                />
              </div>
```

Update the file's doc comment: the line listing "the row-level Call now action and the in-flight shimmer (#11)" as absent is now false — remove it.

- [x] **Step 6: Typecheck and run the whole suite**

Run: `npm run typecheck && npm test && npm run lint`
Expected: all pass.

- [x] **Step 7: Commit**

```bash
git add "app/(app)/layout.tsx" "app/(app)/page.tsx" "app/(app)/actions.ts" \
  components/calls/call-now-button.tsx components/overview/quick-call-card.tsx \
  components/overview/appointments-table.tsx lib/appointments/quick-add-input.ts
git commit -m "Give both surfaces a Call now, and shimmer the row being called"
```

---

### Task 11: Build, verify by hand, and record what is still missing

- [x] **Step 1: Confirm the production build passes**

Run: `npm run build`
Expected: success. This catches a client-only import leaking into a Server Component, which typecheck does not.

- [ ] **Step 2: Place one real Web Call** — NOT DONE. This is a human step by
      design: SPEC.md §3 rule 11 restricts real Calls to explicit manual action,
      and it needs a microphone, live Retell credentials and about seven cents.

The only step that spends money — roughly seven cents — and the only real Call in this ticket (SPEC.md §3 rule 11). Run `npm run dev` and, on `localhost` (the microphone needs HTTPS or localhost):

1. Press "Call now" on a seeded row. Grant the microphone.
2. **Maya greets you by name** and names the real Service and time. Listen for any literal "curly-curly" — there must be none.
3. **Say the time works.** Do not say no: the Tool endpoints are #10 and would 404.
4. While she talks, check the topbar dot reads "1 call in progress" and the row shimmers.
5. Let her end the call. The bar shows the ended state; the row stops shimmering.
6. The sidebar meter has gone up by one.

Then, without granting the microphone, press "Call now" and decline the prompt. The bar must say no call was used, and the meter must not move.

- [ ] **Step 3: Record the result on the issue** — blocked on step 2.

```bash
gh issue comment 11 --body "..."
```

State what was verified, and state plainly what was not: the reschedule path stalls until #10 and #12, and the token-expiry state is proven by unit test rather than in a browser because requesting the microphone first removes the ordinary way to reach it.

- [x] **Step 4: Commit anything outstanding and open the PR**

```bash
git add -A
git commit -m "..."
gh pr create --fill
```

---

## Self-review

**Spec coverage.** Every section of the spec maps to a task: Part 1's ordering → Tasks 4 and 8; Part 2's statement → Task 2; Part 3's modules → Tasks 1–7; Part 4's screen → Tasks 8–10; Part 5's tests → the test step of every task, plus Task 11's manual run. All six acceptance criteria are covered — greeting by name (4, 11), no placeholder (1), the meter blocking the sixth Call (2), admin unlimited (2), both designed failure states (3, 9), the live indicator and shimmer (5, 6, 10).

**Type consistency.** `LiveCallTarget`, `CallState`, `CallEvent` and `IDLE` are defined in Task 3 and used unchanged in Tasks 8–10. `WebCallCreator` is defined in Task 4 and used only there. `Executor` is defined in Task 2 and consumed in Task 4. `AppointmentRow.isCalling` is added in Task 6 and read in Task 10.

**Known gap, carried deliberately.** Task 7's Server Actions have no unit test. Both halves they compose are tested, and the wiring is what Task 11 exercises in the browser.
