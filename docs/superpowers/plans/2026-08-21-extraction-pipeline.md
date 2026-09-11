# Extraction pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a Call ends, one Claude Haiku pass writes notes, a summary and sentiment from the transcript — and, only when no Tool committed, reconstructs the outcome from two fallback fields.

**Architecture:** Five new files under `lib/extraction/`. `prompt.ts` and `parse.ts` are pure functions. `llm.ts` is the only place `ANTHROPIC_API_KEY` is read, and it exports a **function type** that `run.ts` takes as an argument — so tests inject a fake and need no network. `run.ts` only ever writes to `extractions`; `outcome.ts` is the only file here that may write to `appointments`, and it holds the rule that a committed Tool always wins.

**Tech Stack:** TypeScript, Next.js 16, Drizzle ORM, Postgres, Vitest, `@anthropic-ai/sdk`, `claude-haiku-4-5`.

**Design doc:** `docs/superpowers/specs/2026-08-21-extraction-pipeline-design.md`

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `lib/extraction/parse.ts` | Create | Raw model string → validated `ExtractionResult`, or `null` |
| `lib/extraction/prompt.ts` | Create | The prompt text, the JSON schema, the retry nudge |
| `lib/extraction/llm.ts` | Create | `ExtractionLlm` function type + the real Anthropic client |
| `lib/extraction/run.ts` | Create | Orchestration: call, parse, retry once, write the row |
| `lib/extraction/outcome.ts` | Create | The three gates, and the fallback write |
| `lib/db/schema.ts` | Modify | Add the `SENTIMENTS` union; type the `sentiment` column |
| `lib/tools/testing.ts` | Modify | Delete `extractions` rows in `cleanupToolTest` |
| `lib/webhooks/payload.ts` | Modify | Read `call_analysis.in_voicemail` |
| `lib/webhooks/process.ts` | Modify | Run extraction from `applyAnalyzed` |
| `fixtures/transcripts/*.txt` | Create | Four transcripts: confirm, reschedule, decline, voicemail |
| `scripts/try-extraction.ts` | Create | Runs the four against the real API, by hand |

---

## Task 1: Groundwork — dependency, sentiment union, test cleanup

**Why first:** `cleanupToolTest` currently deletes `calls` but not `extractions`. Since `extractions.call_id` has a foreign key to `calls`, the first test that writes an extraction row will make every later cleanup fail with a foreign-key error. Fix it before anything writes one.

**Files:**
- Modify: `package.json` (dependency)
- Modify: `lib/db/schema.ts:97` (after `EXTRACTION_STATUSES`), `lib/db/schema.ts:247` (the column)
- Modify: `lib/tools/testing.ts:157` (inside the per-call delete loop)
- Test: `lib/tools/testing.test.ts` (create)

- [ ] **Step 1: Install the SDK**

```bash
npm install @anthropic-ai/sdk
```

- [ ] **Step 2: Write the failing test**

Create `lib/tools/testing.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import { cleanupToolTest, seedToolTest } from "@/lib/tools/testing";

/*
  One test, for one hazard: `extractions.call_id` references `calls`, so a
  fixture that grew an extraction row can no longer be torn down by a cleanup
  that deletes calls first. The failure lands in whichever test file runs next,
  which is the worst possible place for it to be reported.
*/

const CLERK_ID = "user_test_tools_testing";

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
});

it("tears down a fixture that has an extraction row", async () => {
  const seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: new Date("2026-08-20T09:00:00.000Z"),
  });

  await db
    .insert(schema.extractions)
    .values({ callId: seed.callId, summary: "Anything." });

  await cleanupToolTest(CLERK_ID);

  const user = await db.query.users.findFirst({
    where: eq(schema.users.clerkId, CLERK_ID),
  });
  expect(user).toBeUndefined();
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run lib/tools/testing.test.ts`
Expected: FAIL — a Postgres foreign-key violation on `extractions_call_id_calls_id_fk`.

- [ ] **Step 4: Delete extractions in the cleanup**

In `lib/tools/testing.ts`, inside the `for (const call of calls)` loop, add the extraction delete **before** the tool-invocation delete, and update the comment above it:

```ts
      // extractions and tool_invocations both reference calls, which references
      // appointments. Inner first, or the delete is refused by the foreign key.
      for (const call of calls) {
        await db
          .delete(schema.extractions)
          .where(eq(schema.extractions.callId, call.id));
        await db
          .delete(schema.toolInvocations)
          .where(eq(schema.toolInvocations.callId, call.id));
      }
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npx vitest run lib/tools/testing.test.ts`
Expected: PASS

- [ ] **Step 6: Add the sentiment union**

In `lib/db/schema.ts`, directly below `EXTRACTION_STATUSES`:

```ts
// SPEC.md §9 step 2 fixes these three. Plain `text` in the table like every
// other status column; this union is the contract application code enforces.
export const SENTIMENTS = ["positive", "neutral", "negative"] as const;
export type Sentiment = (typeof SENTIMENTS)[number];
```

And on the `extractions` table, type the column:

```ts
  sentiment: text("sentiment").$type<Sentiment>(),
```

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add package.json package-lock.json lib/db/schema.ts lib/tools/testing.ts lib/tools/testing.test.ts
git commit -m "Let a fixture be torn down after it has been extracted from"
```

---

## Task 2: `parse.ts` — reading the model's answer

**Files:**
- Create: `lib/extraction/parse.ts`
- Test: `lib/extraction/parse.test.ts`

**The contract:** lenient about a key being absent, strict about its type. A key that is present but the wrong type means the schema did not hold, and rejecting the whole object is what triggers the retry. `summary` is the exception that must be present and non-empty — it is the one field SPEC.md §9 always asks for, and it is the cheap tell that the model answered rather than returning `{}`.

- [ ] **Step 1: Write the failing test**

Create `lib/extraction/parse.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { parseExtraction } from "@/lib/extraction/parse";

/*
  What counts as an answer.

  `null` from this function means "malformed", and malformed is what buys the
  one retry in run.ts. So the line between null and a result is the line
  between paying for a second call and not — worth pinning down precisely.
*/

const GOOD = JSON.stringify({
  notes: "Wants a text reminder the day before.",
  summary: "Priya confirmed her Thursday appointment.",
  sentiment: "positive",
  confirmed: true,
  new_time: null,
});

describe("parseExtraction", () => {
  it("reads a complete answer", () => {
    expect(parseExtraction(GOOD)).toEqual({
      notes: "Wants a text reminder the day before.",
      summary: "Priya confirmed her Thursday appointment.",
      sentiment: "positive",
      confirmed: true,
      newTime: null,
    });
  });

  it("reads an answer wrapped in whitespace", () => {
    expect(parseExtraction(`\n  ${GOOD}\n`)?.confirmed).toBe(true);
  });

  it("treats an absent optional key as null", () => {
    const result = parseExtraction(
      JSON.stringify({ summary: "She did not pick up." }),
    );
    expect(result).toEqual({
      notes: null,
      summary: "She did not pick up.",
      sentiment: null,
      confirmed: null,
      newTime: null,
    });
  });

  it("treats an empty string as null", () => {
    const result = parseExtraction(
      JSON.stringify({ summary: "Fine.", notes: "", new_time: "" }),
    );
    expect(result?.notes).toBeNull();
    expect(result?.newTime).toBeNull();
  });

  it("rejects a truncated object", () => {
    expect(parseExtraction('{"summary": "She confir')).toBeNull();
  });

  it("rejects prose that is not JSON at all", () => {
    expect(parseExtraction("Sure! Here is the JSON you asked for.")).toBeNull();
  });

  it("rejects a JSON array", () => {
    expect(parseExtraction('[{"summary": "Fine."}]')).toBeNull();
  });

  it("rejects an empty object, because the summary is missing", () => {
    expect(parseExtraction("{}")).toBeNull();
  });

  it("rejects a summary that is not a string", () => {
    expect(parseExtraction('{"summary": 42}')).toBeNull();
  });

  it("rejects a sentiment outside the three", () => {
    expect(
      parseExtraction('{"summary": "Fine.", "sentiment": "grumpy"}'),
    ).toBeNull();
  });

  it("rejects a confirmed that is a string rather than a boolean", () => {
    expect(
      parseExtraction('{"summary": "Fine.", "confirmed": "yes"}'),
    ).toBeNull();
  });

  it("ignores a key nobody asked for", () => {
    const result = parseExtraction(
      JSON.stringify({ summary: "Fine.", call_successful: true }),
    );
    expect(result?.summary).toBe("Fine.");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/extraction/parse.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/extraction/parse"`.

- [ ] **Step 3: Write the parser**

Create `lib/extraction/parse.ts`:

```ts
import { SENTIMENTS, type Sentiment } from "@/lib/db/schema";

/*
  Reading what the model sent back.

  Null means malformed, and malformed is what buys the one retry in run.ts
  (SPEC.md §9 step 5). Nothing here throws: the caller's job is to decide
  between retrying and recording a failure, and an exception would take that
  decision away from it.

  Lenient about a key being absent, strict about its type. `output_config.format`
  already constrains the shape at the API level (docs/verification.md A11), so a
  wrong type here means the constraint did not hold — which is exactly the case
  worth spending a second call on.

  `summary` is the one required field. Without it, `{}` would parse as a
  perfectly good answer full of nulls, and the retry would never fire on a model
  that returned nothing at all.
*/

export type ExtractionResult = {
  notes: string | null;
  summary: string;
  sentiment: Sentiment | null;
  /** Fallback only. Applied solely when no Tool committed — see outcome.ts. */
  confirmed: boolean | null;
  /** Fallback only, and free text. Never parsed into a Slot (design doc, decision 1). */
  newTime: string | null;
};

export function parseExtraction(raw: string): ExtractionResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  // `typeof [] === "object"`, so the array check is not redundant — the same
  // reasoning as lib/webhooks/payload.ts.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const object = parsed as Record<string, unknown>;

  const summary = optionalText(object.summary);
  if (summary === INVALID || summary === null) return null;

  const notes = optionalText(object.notes);
  if (notes === INVALID) return null;

  const newTime = optionalText(object.new_time);
  if (newTime === INVALID) return null;

  const sentiment = optionalSentiment(object.sentiment);
  if (sentiment === INVALID) return null;

  const confirmed = optionalBoolean(object.confirmed);
  if (confirmed === INVALID) return null;

  return { notes, summary, sentiment, confirmed, newTime };
}

/** Distinct from `null`, which is a legitimate value for every field but `summary`. */
const INVALID = Symbol("invalid");
type Invalid = typeof INVALID;

/**
 * A string, null, or invalid.
 *
 * An empty string becomes null. The model has no way to say "no notes" other
 * than `""` or `null`, and treating those two differently would put an empty
 * string in a column whose null means the same thing.
 */
function optionalText(value: unknown): string | null | Invalid {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return INVALID;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function optionalSentiment(value: unknown): Sentiment | null | Invalid {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return INVALID;
  return SENTIMENTS.includes(value as Sentiment) ? (value as Sentiment) : INVALID;
}

function optionalBoolean(value: unknown): boolean | null | Invalid {
  if (value === undefined || value === null) return null;
  return typeof value === "boolean" ? value : INVALID;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run lib/extraction/parse.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/extraction/parse.ts lib/extraction/parse.test.ts
git commit -m "Decide what counts as an answer, and what buys a second call"
```

---

## Task 3: `prompt.ts` — what the model is told

**Files:**
- Create: `lib/extraction/prompt.ts`
- Test: `lib/extraction/prompt.test.ts`

**Why the appointment time is in the prompt:** without it, "same time next Tuesday" is unreadable and `new_time` comes back as a phrase nobody can act on. It is rendered with `formatForSpeech` rather than `formatInZone` because that is the wording Maya used out loud, so it matches what the transcript actually says.

- [ ] **Step 1: Write the failing test**

Create `lib/extraction/prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  EXTRACTION_SCHEMA,
  extractionPrompt,
  STRICTER_NUDGE,
} from "@/lib/extraction/prompt";

const INPUT = {
  transcript: "Agent: Hello Priya.\nUser: Yes, Thursday works.",
  personName: "Priya Sharma",
  appointmentSpokenTime: "Thursday 20 August at 2:30 PM",
};

describe("extractionPrompt", () => {
  it("includes the transcript verbatim", () => {
    expect(extractionPrompt(INPUT)).toContain(INPUT.transcript);
  });

  it("tells the model who was called and when the appointment is", () => {
    const prompt = extractionPrompt(INPUT);
    expect(prompt).toContain("Priya Sharma");
    expect(prompt).toContain("Thursday 20 August at 2:30 PM");
  });

  it("says confirmed and new_time describe what was said", () => {
    expect(extractionPrompt(INPUT)).toContain("new_time");
  });
});

describe("EXTRACTION_SCHEMA", () => {
  it("declares exactly the five fields the extractions table holds", () => {
    expect(Object.keys(EXTRACTION_SCHEMA.properties).sort()).toEqual([
      "confirmed",
      "new_time",
      "notes",
      "sentiment",
      "summary",
    ]);
  });

  it("closes the object, so the model cannot invent a sixth", () => {
    expect(EXTRACTION_SCHEMA.additionalProperties).toBe(false);
  });

  it("requires every field, so absence is never how the model answers", () => {
    // Copied before sorting: `as const` makes `required` a readonly tuple, and
    // readonly arrays have no `.sort()`.
    expect([...EXTRACTION_SCHEMA.required].sort()).toEqual([
      "confirmed",
      "new_time",
      "notes",
      "sentiment",
      "summary",
    ]);
  });

  it("constrains sentiment to the three the schema union allows", () => {
    expect(EXTRACTION_SCHEMA.properties.sentiment.enum).toEqual([
      "positive",
      "neutral",
      "negative",
      null,
    ]);
  });
});

describe("STRICTER_NUDGE", () => {
  it("is a non-empty instruction, since it is the whole of the retry", () => {
    expect(STRICTER_NUDGE.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/extraction/prompt.test.ts`
Expected: FAIL — cannot resolve `@/lib/extraction/prompt`.

- [ ] **Step 3: Write the prompt**

Create `lib/extraction/prompt.ts`:

```ts
/*
  What the model is told, and what shape it may answer in.

  Pure, and deliberately separate from the client that sends it. The prompt is
  the thing most likely to be edited by hand, and `scripts/try-extraction.ts`
  needs to render it without holding an API key.

  Two things are NOT asked for. Voicemail comes from Retell's own
  `call_analysis.in_voicemail`, which is free and measured rather than inferred
  (SPEC.md §9 step 4). And nothing here asks the model to decide an outcome —
  `confirmed` and `new_time` record what the person said, and outcome.ts alone
  decides whether that is allowed to touch the Appointment.
*/

export type ExtractionInput = {
  transcript: string;
  personName: string;
  /** Already rendered in the Business's timezone, the way Maya said it aloud. */
  appointmentSpokenTime: string;
};

/**
 * The JSON schema handed to `output_config.format`.
 *
 * Every field is required and the object is closed, so "the model left it out"
 * is not a shape the parser has to reason about — an unanswerable field comes
 * back as an explicit null instead. See docs/verification.md A11.
 */
export const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    notes: {
      type: ["string", "null"],
      description:
        "Anything the person said that a receptionist would write down. Null if nothing.",
    },
    summary: {
      type: "string",
      description: "One or two lines describing how the call went.",
    },
    sentiment: {
      type: ["string", "null"],
      enum: ["positive", "neutral", "negative", null],
      description: "How the person sounded about the call overall.",
    },
    confirmed: {
      type: ["boolean", "null"],
      description:
        "True if the person agreed to keep the appointment, false if they refused it outright, null if neither was said.",
    },
    new_time: {
      type: ["string", "null"],
      description:
        "The new time the person asked for, in their own words. Null unless they named one.",
    },
  },
  required: ["notes", "summary", "sentiment", "confirmed", "new_time"],
  additionalProperties: false,
} as const;

export function extractionPrompt({
  transcript,
  personName,
  appointmentSpokenTime,
}: ExtractionInput): string {
  return `You are reading the transcript of a phone call an appointment-reminder assistant made on behalf of a small business.

The person called is ${personName}. Their appointment is currently booked for ${appointmentSpokenTime}.

Read the transcript and report what was said. Do not guess at anything that was not said — every field may be null.

- notes: anything worth writing down. A preference, a reason, a phone number, a request. Not a retelling of the call.
- summary: one or two lines, in plain English.
- sentiment: how the person sounded — positive, neutral or negative.
- confirmed: true only if the person clearly agreed to keep the appointment as booked. False only if they clearly refused it. Null if the call never got there.
- new_time: the time they asked to move to, in their own words ("Friday morning", "same time next week"). Null unless they named one. If they named a new time, confirmed is not true — they did not agree to the existing one.

Transcript:
${transcript}`;
}

/**
 * The whole of the retry (SPEC.md §9 step 5).
 *
 * Appended to the same prompt rather than replacing it, so the retry is asking
 * the same question a second time, more firmly — not a different question whose
 * answer would mean something else.
 */
export const STRICTER_NUDGE = `
Your previous response could not be read. Return only valid JSON matching the schema. No explanation, no markdown fence, no text before or after the object.`;
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run lib/extraction/prompt.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/extraction/prompt.ts lib/extraction/prompt.test.ts
git commit -m "Ask the model only for what the Tools could not record"
```

---

## Task 4: `llm.ts` — the Anthropic call, behind a function type

**Files:**
- Create: `lib/extraction/llm.ts`
- Test: `lib/extraction/llm.test.ts`

**The point of this file:** `run.ts` depends on `ExtractionLlm`, a function type — never on the SDK. That is what lets every test inject a fake and what keeps `ANTHROPIC_API_KEY` out of the test environment. The key is read inside the factory, not at module import, exactly as `lib/retell/client.ts` does it, so `prompt.ts` stays importable on a machine that has never held a key.

- [ ] **Step 1: Write the failing test**

Create `lib/extraction/llm.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { anthropicExtractor } from "@/lib/extraction/llm";

/*
  The only part of this file that can be tested without spending money: the
  refusal to run without a key, and that it happens when the client is built
  rather than when the module is imported.
*/

describe("anthropicExtractor", () => {
  it("refuses to build without a key, and says which one", () => {
    expect(() => anthropicExtractor(undefined)).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("refuses a blank key, which is what copying .env.example leaves behind", () => {
    expect(() => anthropicExtractor("   ")).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("builds with a key", () => {
    expect(typeof anthropicExtractor("sk-ant-test")).toBe("function");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/extraction/llm.test.ts`
Expected: FAIL — cannot resolve `@/lib/extraction/llm`.

- [ ] **Step 3: Write the client**

Create `lib/extraction/llm.ts`:

```ts
import Anthropic from "@anthropic-ai/sdk";

import { EXTRACTION_SCHEMA } from "@/lib/extraction/prompt";

/*
  The Anthropic call, and the seam that keeps it out of every test.

  `run.ts` depends on `ExtractionLlm` — a function — and never on this file's
  implementation. That is not ceremony: it is what makes the four transcripts
  testable with no API key, no network and no cost, which is the whole of
  SPEC.md §10.

  It is also the shape this repo already uses everywhere it touches something
  external: `envStatus(env)`, `verifySignature(secret)`, `runTool({ handler })`.
  There is not one `vi.mock` in the codebase, and this does not add the first.

  Like lib/retell/client.ts, the key is read in the factory rather than at import
  — so prompt.ts and parse.ts stay importable on a machine that has never had
  Anthropic credentials.
*/

/** What the model sent back, before anyone tries to read it. */
export type LlmResponse = {
  /** Every text block, concatenated. Empty string if the response carried none. */
  raw: string;
  /** Anything but `end_turn` means the answer is not whole — see run.ts. */
  stopReason: string | null;
};

export type ExtractionLlm = (prompt: string) => Promise<LlmResponse>;

/** Claude Haiku 4.5 — docs/verification.md A11. ~$0.0016 per extraction. */
const MODEL = "claude-haiku-4-5";

/**
 * Enough for the five fields several times over, and short enough that a model
 * which starts rambling is cut off rather than billed for.
 */
const MAX_TOKENS = 1024;

export function anthropicExtractor(
  apiKey: string | undefined = process.env.ANTHROPIC_API_KEY,
): ExtractionLlm {
  if (!apiKey || apiKey.trim() === "") {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Copy .env.example to .env.local and paste " +
        "the key from https://console.anthropic.com/ — extraction is the only " +
        "thing that needs it, so Calls still run without it.",
    );
  }

  const client = new Anthropic({ apiKey: apiKey.trim() });

  return async (prompt: string): Promise<LlmResponse> => {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: prompt }],
      /*
        Constrains the response shape at the API level, which makes malformed
        JSON very unlikely — not impossible (A11). The retry in run.ts stays.

        Cast because the SDK's published types trail the parameter; the wire
        contract is in docs/verification.md A11. Note it is `output_config`, not
        the deprecated top-level `output_format`.
      */
      output_config: {
        format: { type: "json_schema", schema: EXTRACTION_SCHEMA },
      },
    } as Anthropic.MessageCreateParamsNonStreaming);

    return {
      raw: response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(""),
      stopReason: response.stop_reason,
    };
  };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run lib/extraction/llm.test.ts`
Expected: PASS, 3 tests.

If `npm run typecheck` complains about `output_config`, widen the cast on the argument object to `as unknown as Anthropic.MessageCreateParamsNonStreaming` — do not remove the parameter, and do not switch to `output_format`, which is deprecated API-wide.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add lib/extraction/llm.ts lib/extraction/llm.test.ts
git commit -m "Put the model behind a function, so the tests never call it"
```

---

## Task 5: `outcome.ts` — the three gates

**Written before `run.ts`** because `run.ts` calls it, and because this is the file holding the rule the whole ticket is about.

**Files:**
- Create: `lib/extraction/outcome.ts`
- Test: `lib/extraction/outcome.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/extraction/outcome.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import type { AppointmentStatus, ToolName } from "@/lib/db/schema";
import { applyExtractionOutcome } from "@/lib/extraction/outcome";
import type { ExtractionResult } from "@/lib/extraction/parse";
import {
  cleanupToolTest,
  seedToolTest,
  type ToolTestSeed,
} from "@/lib/tools/testing";

/*
  The rule this ticket exists to protect: a committed Tool outcome always wins
  (SPEC.md §9 step 3).

  The fallback fields are for one case only — a Call where Maya talked to
  somebody and invoked nothing. Every other case must leave the Appointment
  exactly as the Tools left it, and there are more ways for that to be quietly
  wrong than for it to be right, which is why the Tool-wins case gets a
  describe.each rather than a single test.
*/

const CLERK_ID = "user_test_extraction_outcome";
const STARTS_AT = new Date("2026-08-20T09:00:00.000Z");

let seed: ToolTestSeed;

/** What extraction returns for someone who agreed to keep their time. */
function result(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    notes: null,
    summary: "A call happened.",
    sentiment: "neutral",
    confirmed: null,
    newTime: null,
    ...overrides,
  };
}

async function appointment() {
  const row = await db.query.appointments.findFirst({
    where: eq(schema.appointments.id, seed.appointmentId),
  });
  if (!row) throw new Error("fixture appointment vanished");
  return row;
}

/** Put the Appointment where `call_ended` leaves one nobody decided. */
async function setStatus(status: AppointmentStatus) {
  await db
    .update(schema.appointments)
    .set({ status })
    .where(eq(schema.appointments.id, seed.appointmentId));
}

/** A Tool ran on this Call. `succeeded: false` is a Tool that did NOT commit. */
async function recordTool(toolName: ToolName, succeeded = true) {
  await db.insert(schema.toolInvocations).values({
    callId: seed.callId,
    toolName,
    arguments: {},
    result: {},
    succeeded,
  });
}

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: STARTS_AT,
  });
  // Where releaseAppointment leaves an Appointment once its Call is over.
  await setStatus("pending");
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
});

describe("when no Tool committed", () => {
  it("confirms an Appointment the person agreed to keep", async () => {
    await applyExtractionOutcome({
      callId: seed.callId,
      appointmentId: seed.appointmentId,
      inVoicemail: null,
      result: result({ confirmed: true }),
    });

    expect((await appointment()).status).toBe("confirmed");
  });

  it("declines one the person refused, which frees the Slot", async () => {
    await applyExtractionOutcome({
      callId: seed.callId,
      appointmentId: seed.appointmentId,
      inVoicemail: null,
      result: result({ confirmed: false }),
    });

    // `declined` is in SLOT_FREEING_STATUSES, so the Slot is released by the
    // status alone — there is no second step that could disagree with it.
    expect((await appointment()).status).toBe("declined");
  });

  it("flags a new time for a human, and never books it", async () => {
    await applyExtractionOutcome({
      callId: seed.callId,
      appointmentId: seed.appointmentId,
      inVoicemail: null,
      result: result({ newTime: "Friday morning" }),
    });

    const row = await appointment();
    expect(row.needsAttentionReason).toBe("negotiation_truncated");
    expect(row.status).toBe("pending");
    expect(row.startsAt).toEqual(STARTS_AT);
  });

  it("lets a new time outrank a confirmation in the same answer", async () => {
    await applyExtractionOutcome({
      callId: seed.callId,
      appointmentId: seed.appointmentId,
      inVoicemail: null,
      result: result({ confirmed: true, newTime: "Friday morning" }),
    });

    const row = await appointment();
    expect(row.status).toBe("pending");
    expect(row.needsAttentionReason).toBe("negotiation_truncated");
  });

  it("does nothing when the call never got to an outcome", async () => {
    await applyExtractionOutcome({
      callId: seed.callId,
      appointmentId: seed.appointmentId,
      inVoicemail: null,
      result: result(),
    });

    const row = await appointment();
    expect(row.status).toBe("pending");
    expect(row.needsAttentionReason).toBeNull();
  });

  it("leaves a Tool that ran and FAILED to the fallback", async () => {
    // A book_slot the exclusion constraint rejected committed nothing, so there
    // is no outcome for it to defend (SPEC.md §9 step 3).
    await recordTool("book_slot", false);

    await applyExtractionOutcome({
      callId: seed.callId,
      appointmentId: seed.appointmentId,
      inVoicemail: null,
      result: result({ confirmed: true }),
    });

    expect((await appointment()).status).toBe("confirmed");
  });

  it("leaves a check_availability to the fallback, because a read commits nothing", async () => {
    await recordTool("check_availability");

    await applyExtractionOutcome({
      callId: seed.callId,
      appointmentId: seed.appointmentId,
      inVoicemail: null,
      result: result({ confirmed: true }),
    });

    expect((await appointment()).status).toBe("confirmed");
  });
});

describe("when a Tool committed", () => {
  const committed: { tool: ToolName; status: AppointmentStatus }[] = [
    { tool: "confirm_appointment", status: "confirmed" },
    { tool: "book_slot", status: "rescheduled" },
    { tool: "cancel_appointment", status: "cancelled" },
  ];

  const contradictions: ExtractionResult[] = [
    result({ confirmed: true }),
    result({ confirmed: false }),
    result({ newTime: "Friday morning" }),
  ];

  for (const { tool, status } of committed) {
    for (const [index, contradiction] of contradictions.entries()) {
      it(`keeps ${status} after ${tool}, whatever extraction says (${index})`, async () => {
        await recordTool(tool);
        await setStatus(status);

        await applyExtractionOutcome({
          callId: seed.callId,
          appointmentId: seed.appointmentId,
          inVoicemail: null,
          result: contradiction,
        });

        const row = await appointment();
        expect(row.status).toBe(status);
        expect(row.needsAttentionReason).toBeNull();
      });
    }
  }
});

describe("when Retell says it was a voicemail", () => {
  it("writes nothing, because nobody was on the line", async () => {
    await applyExtractionOutcome({
      callId: seed.callId,
      appointmentId: seed.appointmentId,
      inVoicemail: true,
      result: result({ confirmed: true, newTime: "Friday morning" }),
    });

    const row = await appointment();
    expect(row.status).toBe("pending");
    expect(row.needsAttentionReason).toBeNull();
  });
});

describe("the status guard", () => {
  it("will not move an Appointment that is not pending", async () => {
    // No tool_invocations row at all, so only the third gate can stop this.
    await setStatus("rescheduled");

    await applyExtractionOutcome({
      callId: seed.callId,
      appointmentId: seed.appointmentId,
      inVoicemail: null,
      result: result({ confirmed: false }),
    });

    expect((await appointment()).status).toBe("rescheduled");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/extraction/outcome.test.ts`
Expected: FAIL — cannot resolve `@/lib/extraction/outcome`.

- [ ] **Step 3: Write the outcome step**

Create `lib/extraction/outcome.ts`:

```ts
import { and, eq, inArray } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type {
  AppointmentStatus,
  NeedsAttentionReason,
  ToolName,
} from "@/lib/db/schema";
import type { ExtractionResult } from "@/lib/extraction/parse";

/*
  The only file in this ticket that may write to `appointments`.

  SPEC.md §9 step 3 in one sentence: a committed Tool outcome always wins. The
  fallback fields exist for one case — a Call where the Agent invoked nothing at
  all — and must never overwrite what a Tool already wrote.

  Three gates enforce that, and any one of them stops the write. They are
  deliberately redundant: the second is the rule, and the third is the same rule
  asked of the Appointment itself, so a bug in reading `tool_invocations` still
  cannot move a decided Appointment.
*/

/**
 * The Tools that write an outcome.
 *
 * `check_availability` is absent on purpose. It is a read — a Call where Maya
 * only ever checked times is a Call where no Tool committed, and the fallback
 * is exactly what that Call needs.
 */
const COMMITTING_TOOLS: readonly ToolName[] = [
  "book_slot",
  "confirm_appointment",
  "cancel_appointment",
];

export type ExtractionOutcomeInput = {
  callId: string;
  appointmentId: string;
  /** Retell's own signal, never the model's guess (SPEC.md §9 step 4). */
  inVoicemail: boolean | null;
  result: ExtractionResult;
};

export async function applyExtractionOutcome({
  callId,
  appointmentId,
  inVoicemail,
  result,
}: ExtractionOutcomeInput): Promise<void> {
  // Gate 1. A voicemail has a transcript worth summarising and no one to have
  // agreed to anything in it.
  if (inVoicemail === true) return;

  // Gate 2. The rule.
  if (await aToolCommitted(callId)) return;

  const change = fallbackChange(result);
  if (!change) return;

  /*
    Gate 3, and note where it lives: inside the WHERE clause, not in a read
    followed by an `if`. Same shape as `releaseAppointment` in
    lib/calls/record.ts, and for the same reason — two workers processing a
    redelivered event cannot both win a check they each made before writing.

    `pending` is where an Appointment nobody decided sits by the time
    `call_analyzed` lands, because `call_ended` already ran releaseAppointment.
    One a Tool decided is `confirmed`, `rescheduled` or `cancelled`, and matches
    nothing here.
  */
  await db
    .update(schema.appointments)
    .set(change)
    .where(
      and(
        eq(schema.appointments.id, appointmentId),
        eq(schema.appointments.status, "pending"),
      ),
    );
}

/** Did a Tool write an outcome on this Call? */
async function aToolCommitted(callId: string): Promise<boolean> {
  const committed = await db.query.toolInvocations.findFirst({
    where: and(
      eq(schema.toolInvocations.callId, callId),
      eq(schema.toolInvocations.succeeded, true),
      inArray(schema.toolInvocations.toolName, [...COMMITTING_TOOLS]),
    ),
    columns: { id: true },
  });

  return committed !== undefined;
}

/**
 * What the fallback fields mean for the Appointment, or null for "nothing".
 *
 * `new_time` outranks `confirmed`: a person who named a new time did not agree
 * to the old one, whatever else came back in the same object. It sets a Needs
 * Attention reason rather than a status, so the Appointment keeps its Slot and
 * a human does the Reschedule — an LLM parsing a spoken time into a booking
 * would route around the exclusion constraint, the offer-replay check in
 * lib/tools/book-slot.ts, and Google Calendar in one step.
 */
function fallbackChange(result: ExtractionResult): {
  status?: Extract<AppointmentStatus, "confirmed" | "declined">;
  needsAttentionReason?: NeedsAttentionReason;
} | null {
  if (result.newTime !== null) {
    /*
      SPEC.md §5 words this reason as the 120-second cap. We use it for the
      wider case it describes — no Tool committed during a negotiation — because
      the failure, the fix and the UI surface are all the same. Recorded as
      decision 4 in the design doc so it reads as a choice, not a drift.
    */
    return { needsAttentionReason: "negotiation_truncated" };
  }

  if (result.confirmed === true) return { status: "confirmed" };
  if (result.confirmed === false) return { status: "declined" };

  return null;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run lib/extraction/outcome.test.ts`
Expected: PASS, 19 tests (7 + 9 from the two loops + 1 + 1 + 1).

- [ ] **Step 5: Commit**

```bash
git add lib/extraction/outcome.ts lib/extraction/outcome.test.ts
git commit -m "Hold the line that a committed Tool outcome always wins"
```

---

## Task 6: `run.ts` — call, parse, retry once, write the row

**Files:**
- Create: `lib/extraction/run.ts`
- Test: `lib/extraction/run.test.ts`
- Create: `fixtures/transcripts/confirm.txt`, `reschedule.txt`, `decline.txt`, `voicemail.txt`

- [ ] **Step 1: Write the four transcripts**

These are the acceptance criterion. Create `fixtures/transcripts/confirm.txt`:

```
Agent: Hi, is this Priya? This is Maya calling from Tool Test Salon about your haircut.
User: Yes, speaking.
Agent: Lovely. I'm just calling to confirm your appointment on Thursday the twentieth of August at 2:30 PM. Does that still work for you?
User: Yes, that's fine. Thursday at half two.
Agent: Wonderful, you're all confirmed. See you Thursday.
User: Thanks. Oh — could you send me a text the day before? I forget these things.
Agent: Of course, I'll make a note of that. Have a good day.
```

Create `fixtures/transcripts/reschedule.txt`:

```
Agent: Hi, is this Priya? This is Maya calling from Tool Test Salon about your haircut.
User: Hi, yes.
Agent: I'm calling to confirm your appointment on Thursday the twentieth of August at 2:30 PM.
User: Ah — I can't do Thursday any more, something's come up at work. Could I do Friday morning instead?
Agent: Let me have a look at Friday for you.
User: Anything before lunch would be great.
Agent: I'm sorry, I'm having trouble pulling up the calendar. Someone will call you back to sort out Friday.
User: No problem, thanks.
```

Create `fixtures/transcripts/decline.txt`:

```
Agent: Hi, is this Priya? This is Maya calling from Tool Test Salon about your haircut.
User: Yes.
Agent: I'm calling to confirm your appointment on Thursday the twentieth of August at 2:30 PM.
User: Actually, no. I don't want it any more. I've moved out of the area.
Agent: I'm sorry to hear that. I'll take that off the books.
User: Thanks. Don't call again please.
```

Create `fixtures/transcripts/voicemail.txt`:

```
Agent: Hi, this is Maya calling from Tool Test Salon for Priya. I'm ringing about your haircut on Thursday the twentieth of August at 2:30 PM. Please give us a call back to confirm. Thanks.
```

- [ ] **Step 2: Write the failing test**

Create `lib/extraction/run.test.ts`:

```ts
import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import type { ExtractionLlm } from "@/lib/extraction/llm";
import { extractCall } from "@/lib/extraction/run";
import {
  cleanupToolTest,
  seedToolTest,
  type ToolTestSeed,
} from "@/lib/tools/testing";

/*
  The four transcripts of SPEC.md §10, and no telephony.

  The LLM is a function this test supplies, so what is proved here is the
  pipeline around it: that a good answer lands, that a bad one is retried
  exactly once, that a second bad one fails softly with the raw output kept, and
  that none of it can reach the Appointment when it fails.

  Whether the PROMPT works on a real model is a different question and a
  different tool — scripts/try-extraction.ts. Neither substitutes for the other.
*/

const CLERK_ID = "user_test_extraction_run";
const STARTS_AT = new Date("2026-08-20T09:00:00.000Z");

let seed: ToolTestSeed;

function transcript(name: string): string {
  return readFileSync(`fixtures/transcripts/${name}.txt`, "utf8");
}

/** An LLM that always answers the same thing, and counts how often it was asked. */
function fakeLlm(...answers: string[]): ExtractionLlm & { prompts: string[] } {
  const prompts: string[] = [];
  const llm = async (prompt: string) => {
    prompts.push(prompt);
    const answer = answers[prompts.length - 1] ?? answers[answers.length - 1];
    return { raw: answer, stopReason: "end_turn" };
  };
  return Object.assign(llm, { prompts });
}

function answer(fields: Record<string, unknown>): string {
  return JSON.stringify({
    notes: null,
    summary: "A call happened.",
    sentiment: "neutral",
    confirmed: null,
    new_time: null,
    ...fields,
  });
}

async function setTranscript(text: string | null) {
  await db
    .update(schema.calls)
    .set({ transcript: text, status: "completed" })
    .where(eq(schema.calls.id, seed.callId));
}

async function extraction() {
  return db.query.extractions.findFirst({
    where: eq(schema.extractions.callId, seed.callId),
  });
}

async function appointment() {
  const row = await db.query.appointments.findFirst({
    where: eq(schema.appointments.id, seed.appointmentId),
  });
  if (!row) throw new Error("fixture appointment vanished");
  return row;
}

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: STARTS_AT,
  });
  await db
    .update(schema.appointments)
    .set({ status: "pending" })
    .where(eq(schema.appointments.id, seed.appointmentId));
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
});

describe("the four transcripts", () => {
  it("records a confirmation, and confirms the Appointment", async () => {
    await setTranscript(transcript("confirm"));
    const llm = fakeLlm(
      answer({
        confirmed: true,
        sentiment: "positive",
        notes: "Wants a text reminder the day before.",
        summary: "Priya confirmed her Thursday appointment.",
      }),
    );

    expect(await extractCall({ callId: seed.callId, inVoicemail: false, llm })).toBe("ok");

    const row = await extraction();
    expect(row?.status).toBe("ok");
    expect(row?.confirmed).toBe(true);
    expect(row?.notes).toBe("Wants a text reminder the day before.");
    expect((await appointment()).status).toBe("confirmed");
  });

  it("records a reschedule, and flags it rather than booking it", async () => {
    await setTranscript(transcript("reschedule"));
    const llm = fakeLlm(answer({ new_time: "Friday morning", sentiment: "neutral" }));

    expect(await extractCall({ callId: seed.callId, inVoicemail: false, llm })).toBe("ok");

    expect((await extraction())?.newTime).toBe("Friday morning");
    const row = await appointment();
    expect(row.needsAttentionReason).toBe("negotiation_truncated");
    expect(row.startsAt).toEqual(STARTS_AT);
  });

  it("records a decline, and frees the Slot", async () => {
    await setTranscript(transcript("decline"));
    const llm = fakeLlm(answer({ confirmed: false, sentiment: "negative" }));

    expect(await extractCall({ callId: seed.callId, inVoicemail: false, llm })).toBe("ok");

    expect((await extraction())?.confirmed).toBe(false);
    expect((await appointment()).status).toBe("declined");
  });

  it("records a voicemail from Retell, and never applies its fallback", async () => {
    await setTranscript(transcript("voicemail"));
    // A model with nothing to go on can still return something; it must not matter.
    const llm = fakeLlm(answer({ confirmed: true }));

    expect(await extractCall({ callId: seed.callId, inVoicemail: true, llm })).toBe("ok");

    const row = await extraction();
    expect(row?.inVoicemail).toBe(true);
    expect(row?.summary).toBe("A call happened.");
    expect((await appointment()).status).toBe("pending");
  });
});

describe("the prompt it builds", () => {
  it("carries the transcript, the person and the appointment time", async () => {
    await setTranscript(transcript("confirm"));
    const llm = fakeLlm(answer({}));

    await extractCall({ callId: seed.callId, inVoicemail: false, llm });

    expect(llm.prompts[0]).toContain("Priya Sharma");
    expect(llm.prompts[0]).toContain("Maya calling from Tool Test Salon");
    // 09:00 UTC is 2:30 PM in Asia/Kolkata, the seed's timezone.
    expect(llm.prompts[0]).toContain("2:30 PM");
  });
});

describe("when the answer cannot be read", () => {
  it("retries exactly once, and takes the second answer", async () => {
    await setTranscript(transcript("confirm"));
    const llm = fakeLlm("Sure! Here you go:", answer({ confirmed: true }));

    expect(await extractCall({ callId: seed.callId, inVoicemail: false, llm })).toBe("ok");

    expect(llm.prompts).toHaveLength(2);
    expect(llm.prompts[1]).toContain("only valid JSON");
    expect((await appointment()).status).toBe("confirmed");
  });

  it("fails softly on the second failure, keeping the raw output", async () => {
    await setTranscript(transcript("confirm"));
    const llm = fakeLlm("not json", "still not json");

    expect(await extractCall({ callId: seed.callId, inVoicemail: false, llm })).toBe("failed");

    const row = await extraction();
    expect(row?.status).toBe("failed");
    expect(row?.rawLlmOutput).toBe("still not json");
    expect(row?.summary).toBeNull();
  });

  it("never changes the Appointment when it failed", async () => {
    await setTranscript(transcript("decline"));
    const llm = fakeLlm("not json", "still not json");

    await extractCall({ callId: seed.callId, inVoicemail: false, llm });

    const row = await appointment();
    expect(row.status).toBe("pending");
    expect(row.needsAttentionReason).toBeNull();
  });

  it("treats a truncated response as malformed, on the stop reason alone", async () => {
    await setTranscript(transcript("confirm"));
    // Valid JSON so far as it goes — but the model was cut off, so it is not
    // the whole answer and must not be read as one.
    const cut = answer({ confirmed: true });
    const llm: ExtractionLlm = async () => ({ raw: cut, stopReason: "max_tokens" });

    expect(await extractCall({ callId: seed.callId, inVoicemail: false, llm })).toBe("failed");
    expect((await extraction())?.status).toBe("failed");
    expect((await appointment()).status).toBe("pending");
  });
});

describe("when there is nothing to do", () => {
  it("does not call the model when the Call has no transcript", async () => {
    await setTranscript(null);
    const llm = fakeLlm(answer({}));

    expect(await extractCall({ callId: seed.callId, inVoicemail: null, llm })).toBe("skipped");
    expect(llm.prompts).toHaveLength(0);
    expect(await extraction()).toBeUndefined();
  });

  it("does not call the model twice for a redelivered event", async () => {
    await setTranscript(transcript("confirm"));
    const first = fakeLlm(answer({ confirmed: true }));
    await extractCall({ callId: seed.callId, inVoicemail: false, llm: first });

    const second = fakeLlm(answer({ confirmed: false }));
    expect(
      await extractCall({ callId: seed.callId, inVoicemail: false, llm: second }),
    ).toBe("skipped");

    expect(second.prompts).toHaveLength(0);
    expect((await appointment()).status).toBe("confirmed");
  });

  it("does nothing for a Call it cannot find", async () => {
    const llm = fakeLlm(answer({}));
    expect(
      await extractCall({
        callId: "00000000-0000-0000-0000-000000000000",
        inVoicemail: null,
        llm,
      }),
    ).toBe("skipped");
    expect(llm.prompts).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run lib/extraction/run.test.ts`
Expected: FAIL — cannot resolve `@/lib/extraction/run`.

- [ ] **Step 4: Write the orchestrator**

Create `lib/extraction/run.ts`:

```ts
import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type { ExtractionLlm } from "@/lib/extraction/llm";
import { applyExtractionOutcome } from "@/lib/extraction/outcome";
import { parseExtraction, type ExtractionResult } from "@/lib/extraction/parse";
import { extractionPrompt, STRICTER_NUDGE } from "@/lib/extraction/prompt";
import { formatForSpeech } from "@/lib/time/zone";

/*
  One pass over a finished transcript (SPEC.md §9).

  This file only ever writes to `extractions`. The Appointment is
  outcome.ts's business, and it is reached from exactly one line below — the one
  guarded by whether the insert actually happened.

  Nothing here throws for an ordinary reason. A Call with no transcript, a Call
  that has already been extracted, a Call that does not exist: all of them return
  "skipped". The caller in lib/webhooks/process.ts still wraps it, because a
  timeout or a 429 from Anthropic is not an ordinary reason and must not break
  the Call row that has already been written (SPEC.md §3 rule 5).
*/

export type ExtractOutcome = "ok" | "failed" | "skipped";

export type ExtractCallInput = {
  callId: string;
  /** Retell's `call_analysis.in_voicemail`. Null on events that do not carry it. */
  inVoicemail: boolean | null;
  llm: ExtractionLlm;
};

export async function extractCall({
  callId,
  inVoicemail,
  llm,
}: ExtractCallInput): Promise<ExtractOutcome> {
  const context = await loadContext(callId);
  if (!context) return "skipped";

  /*
    The cheap half of the idempotency story. The expensive half is the unique
    constraint on `extractions.call_id`, which is what actually holds when two
    workers get the same redelivered event at once — see the insert below.
  */
  const already = await db.query.extractions.findFirst({
    where: eq(schema.extractions.callId, callId),
    columns: { id: true },
  });
  if (already) return "skipped";

  const prompt = extractionPrompt({
    transcript: context.transcript,
    personName: context.personName,
    appointmentSpokenTime: formatForSpeech(context.startsAt, context.timezone),
  });

  const { result, raw } = await ask(llm, prompt);

  if (!result) {
    /*
      Second failure. Store the raw output and stop — SPEC.md §9 step 5. Note
      what is NOT here: any call to applyExtractionOutcome. A failed extraction
      never changes an Appointment's status.
    */
    await db
      .insert(schema.extractions)
      .values({
        callId,
        inVoicemail,
        status: "failed",
        rawLlmOutput: raw,
      })
      .onConflictDoNothing();

    console.error(`[extraction] ${callId}: unreadable after one retry`);
    return "failed";
  }

  const [inserted] = await db
    .insert(schema.extractions)
    .values({
      callId,
      notes: result.notes,
      summary: result.summary,
      sentiment: result.sentiment,
      // Retell's own signal, never the model's guess (SPEC.md §9 step 4).
      inVoicemail,
      confirmed: result.confirmed,
      newTime: result.newTime,
      status: "ok",
    })
    .onConflictDoNothing()
    .returning({ id: schema.extractions.id });

  /*
    No row came back, so the unique constraint refused it: another worker
    extracted this Call while we were talking to Anthropic, and has already
    applied the outcome. Applying it a second time would be harmless today —
    every write is a fixed value — but "harmless because of how the writes
    happen to be shaped" is not a guarantee worth resting on.
  */
  if (!inserted) return "skipped";

  await applyExtractionOutcome({
    callId,
    appointmentId: context.appointmentId,
    inVoicemail,
    result,
  });

  return "ok";
}

/**
 * Ask once; if the answer cannot be read, ask again more firmly.
 *
 * Exactly one retry, which is what SPEC.md §9 step 5 allows. `raw` is always the
 * last thing the model said, so a stored failure shows what it was actually
 * doing rather than what it did on the first attempt.
 */
async function ask(
  llm: ExtractionLlm,
  prompt: string,
): Promise<{ result: ExtractionResult | null; raw: string }> {
  const first = await llm(prompt);
  const parsed = readable(first);
  if (parsed) return { result: parsed, raw: first.raw };

  const second = await llm(`${prompt}\n${STRICTER_NUDGE}`);
  return { result: readable(second), raw: second.raw };
}

/**
 * The stop reason is checked before the text is.
 *
 * `max_tokens` truncates mid-object and `refusal` returns something that will
 * not match the schema (docs/verification.md A11). Both would otherwise surface
 * as a parse error one layer too late, and a truncated object that happens to
 * close its braces would surface as a wrong answer rather than an error at all.
 */
function readable(response: {
  raw: string;
  stopReason: string | null;
}): ExtractionResult | null {
  if (response.stopReason !== "end_turn") return null;
  return parseExtraction(response.raw);
}

type ExtractionContext = {
  transcript: string;
  personName: string;
  startsAt: Date;
  timezone: string;
  appointmentId: string;
};

/**
 * Everything the prompt and the outcome step need, in one read.
 *
 * The transcript comes from the Call row rather than from the delivery that
 * triggered this: `applyAnalyzed` has already run its fill-if-null write, so the
 * row holds whichever event carried the transcript first.
 */
async function loadContext(callId: string): Promise<ExtractionContext | null> {
  const rows = await db
    .select({
      transcript: schema.calls.transcript,
      appointmentId: schema.appointments.id,
      personName: schema.appointments.name,
      startsAt: schema.appointments.startsAt,
      timezone: schema.businesses.timezone,
    })
    .from(schema.calls)
    .innerJoin(
      schema.appointments,
      eq(schema.calls.appointmentId, schema.appointments.id),
    )
    .innerJoin(
      schema.businesses,
      eq(schema.appointments.businessId, schema.businesses.id),
    )
    .where(eq(schema.calls.id, callId))
    .limit(1);

  const row = rows[0];
  // No such Call, or a Call nobody spoke on. A no-answer has nothing to read.
  if (!row?.transcript) return null;

  return { ...row, transcript: row.transcript };
}
```

**Note on the uuid cast:** `loadContext` is passed a `callId` that comes from our own database in production, but the "Call it cannot find" test passes a literal. That literal is a valid uuid, so Postgres will not raise. Do not add a try/catch here — `lib/webhooks/process.ts:165` already explains where the malformed-uuid hazard actually lives, and it is not on this path.

- [ ] **Step 5: Run it and watch it pass**

Run: `npx vitest run lib/extraction/run.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 6: Commit**

```bash
git add lib/extraction/run.ts lib/extraction/run.test.ts fixtures/transcripts
git commit -m "Read four transcripts, and retry once before giving up quietly"
```

---

## Task 7: `payload.ts` — read the voicemail flag

**Files:**
- Modify: `lib/webhooks/payload.ts:34` (the type), `lib/webhooks/payload.ts:56` (the return)
- Test: `lib/webhooks/payload.test.ts` (existing — add a describe block)

- [ ] **Step 1: Write the failing test**

Append to `lib/webhooks/payload.test.ts`:

```ts
describe("call_analysis.in_voicemail", () => {
  function parse(call: Record<string, unknown>) {
    return parseWebhookPayload(
      JSON.stringify({ event: "call_analyzed", call: { call_id: "c1", ...call } }),
    );
  }

  it("reads the flag when the analysis carries it", () => {
    expect(parse({ call_analysis: { in_voicemail: true } })?.inVoicemail).toBe(true);
    expect(parse({ call_analysis: { in_voicemail: false } })?.inVoicemail).toBe(false);
  });

  it("is null when there is no analysis — call_ended never carries one", () => {
    expect(parse({})?.inVoicemail).toBeNull();
  });

  it("is null rather than false when the flag is not a boolean", () => {
    // Null means "Retell did not say", which is not the same as "not a
    // voicemail". Only an explicit `true` stops the outcome step.
    expect(parse({ call_analysis: { in_voicemail: "yes" } })?.inVoicemail).toBeNull();
  });
});
```

If `parseWebhookPayload` is not already imported at the top of that file, add it.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/webhooks/payload.test.ts`
Expected: FAIL — `inVoicemail` is `undefined`, not `true`.

- [ ] **Step 3: Read the field**

In `lib/webhooks/payload.ts`, add to the `WebhookEvent` type, after `recordingUrl`:

```ts
  /**
   * `call_analysis.in_voicemail`. Retell measures this; nothing infers it
   * (SPEC.md §9 step 4). Only `call_analyzed` carries `call_analysis` at all
   * (docs/verification.md A9), so it is null on the other two events — and null
   * means "Retell did not say", never "not a voicemail".
   */
  inVoicemail: boolean | null;
```

Add to the returned object, after `recordingUrl`:

```ts
    inVoicemail: isObject(call.call_analysis)
      ? asBoolean(call.call_analysis.in_voicemail)
      : null,
```

And add the helper beside `asText`:

```ts
/** A boolean, or null. Anything else is "Retell did not say". */
function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run lib/webhooks/payload.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/webhooks/payload.ts lib/webhooks/payload.test.ts
git commit -m "Take voicemail from Retell, which measured it"
```

---

## Task 8: `process.ts` — run extraction from the analyzed handler

**Files:**
- Modify: `lib/webhooks/process.ts:40` (the signature), `lib/webhooks/process.ts:112-141` (`applyAnalyzed`)
- Test: `lib/webhooks/process.test.ts` (existing — the `call_analyzed` tests need a fake)

**The hazard this task must not create:** `processWebhookEvent` is called by `process.test.ts` with real `call_analyzed` events. If extraction builds its own Anthropic client, that test suite starts making paid API calls the moment someone has a key in `.env.local`. The extractor is therefore an optional argument, and the existing tests pass a fake.

- [ ] **Step 1: Write the failing test**

Add to `lib/webhooks/process.test.ts`, inside the `call_analyzed` describe block (and import `extraction`-related helpers at the top):

```ts
  it("extracts the transcript once the analysis lands", async () => {
    await db
      .update(schema.calls)
      .set({ transcript: "Agent: Hello.\nUser: Yes, that's fine." })
      .where(eq(schema.calls.id, seed.callId));

    await processWebhookEvent(
      event("call_analyzed", { call_analysis: { in_voicemail: false } }),
      async () => ({
        raw: JSON.stringify({
          notes: null,
          summary: "She confirmed.",
          sentiment: "positive",
          confirmed: true,
          new_time: null,
        }),
        stopReason: "end_turn",
      }),
    );

    const row = await db.query.extractions.findFirst({
      where: eq(schema.extractions.callId, seed.callId),
    });
    expect(row?.summary).toBe("She confirmed.");
  });

  it("does not break the Call row when the model is unreachable", async () => {
    await db
      .update(schema.calls)
      .set({ transcript: "Agent: Hello." })
      .where(eq(schema.calls.id, seed.callId));

    await expect(
      processWebhookEvent(
        event("call_analyzed", { recording_url: "https://example.com/r.wav" }),
        async () => {
          throw new Error("connect ETIMEDOUT");
        },
      ),
    ).resolves.toBeUndefined();

    // SPEC.md §3 rule 5: the Call row still got what the delivery carried.
    expect((await call())?.recordingUrl).toBe("https://example.com/r.wav");
  });
```

Then find every **other** existing test in that file that sends a `call_analyzed` event and give it a fake extractor as the second argument, so no test can reach the network:

```ts
    await processWebhookEvent(event("call_analyzed", { ... }), async () => ({
      raw: "",
      stopReason: "end_turn",
    }));
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/webhooks/process.test.ts`
Expected: FAIL — `processWebhookEvent` takes one argument; no extraction row is written.

- [ ] **Step 3: Wire it in**

In `lib/webhooks/process.ts`, add the imports:

```ts
import { anthropicExtractor, type ExtractionLlm } from "@/lib/extraction/llm";
import { extractCall } from "@/lib/extraction/run";
```

Change the signature and pass the extractor down:

```ts
export async function processWebhookEvent(
  event: WebhookEvent,
  /**
   * The extraction model, injected. Defaulted lazily rather than here, because
   * building the real one reads ANTHROPIC_API_KEY and throws without it — a
   * `call_started` on a deployment that has no key must still be processed.
   */
  extractor?: ExtractionLlm,
): Promise<void> {
```

and in the switch:

```ts
    case "call_analyzed":
      return applyAnalyzed(callId, event, extractor);
```

Replace `applyAnalyzed` entirely:

```ts
/**
 * The analysis has finished.
 *
 * Two jobs. Fill-if-null on the Call row, never overwriting and never touching
 * the status — A9 records `recording_url` timing as unverified, so take
 * whichever event carries it first and let the other be a no-op. Then Extraction
 * (SPEC.md §9), which is why this event is the one that matters.
 */
async function applyAnalyzed(
  callId: string,
  event: WebhookEvent,
  extractor?: ExtractionLlm,
) {
  if (event.transcript || event.recordingUrl) {
    await db
      .update(schema.calls)
      .set({
        ...(event.transcript
          ? {
              transcript: sql`coalesce(${schema.calls.transcript}, ${event.transcript})`,
            }
          : {}),
        ...(event.recordingUrl
          ? {
              recordingUrl: sql`coalesce(${schema.calls.recordingUrl}, ${event.recordingUrl})`,
            }
          : {}),
      })
      .where(eq(schema.calls.id, callId));
  }

  /*
    Extraction runs after the write above, not instead of it: this delivery may
    carry no transcript at all while the row already holds one from `call_ended`.

    Wrapped, and the wrap is the rule rather than caution. SPEC.md §3 rule 5 says
    extraction must never crash the pipeline — a timeout, a 429, or a missing
    ANTHROPIC_API_KEY on a deployment that never configured one must not undo the
    Call row this handler has already written. `anthropicExtractor()` is called
    inside the try for exactly that reason: it throws when the key is absent.
  */
  try {
    await extractCall({
      callId,
      inVoicemail: event.inVoicemail,
      llm: extractor ?? anthropicExtractor(),
    });
  } catch (error) {
    console.error(`[extraction] ${callId} failed:`, error);
  }
}
```

Finally, delete the stale line in the file's header comment that says extraction "is deliberately not here: this ticket ends at the Call row" — it now is here.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run lib/webhooks/process.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/webhooks/process.ts lib/webhooks/process.test.ts
git commit -m "Hang Extraction off the event that carries the analysis"
```

---

## Task 9: `scripts/try-extraction.ts` — prove the prompt, by hand

**Files:**
- Create: `scripts/try-extraction.ts`
- Modify: `package.json` (add the script)

**Why this exists:** the vitest suite can pass with a prompt that would confuse a real model, because the model is a fake. This is the other half of the acceptance criterion, and it needs no Call, no phone number and no webhook — about $0.0016 per transcript.

- [ ] **Step 1: Write the script**

Create `scripts/try-extraction.ts`:

```ts
import { readFileSync } from "node:fs";

import { config } from "dotenv";

import { anthropicExtractor } from "@/lib/extraction/llm";
import { parseExtraction } from "@/lib/extraction/parse";
import { extractionPrompt, STRICTER_NUDGE } from "@/lib/extraction/prompt";

/*
  The four transcripts of SPEC.md §10, against the real Claude Haiku.

  Run this when the prompt changes. lib/extraction/run.test.ts proves the
  pipeline with a fake and cannot tell you whether a real model understands what
  it is being asked — that is this script's only job, and the reason it is a
  script rather than a test: it costs about $0.0016 a transcript and needs a key.

  No database, no Call, no webhook. Run with:  npm run try-extraction
*/

config({ path: ".env.local" });

/** What each transcript should produce, so a wrong answer is obvious on sight. */
const CASES = [
  { name: "confirm", expect: "confirmed: true, no new_time" },
  { name: "reschedule", expect: "new_time set, confirmed not true" },
  { name: "decline", expect: "confirmed: false, no new_time" },
  { name: "voicemail", expect: "confirmed: null — nobody answered" },
] as const;

const PERSON = "Priya Sharma";
const SPOKEN_TIME = "Thursday 20 August at 2:30 PM";

async function main() {
  const llm = anthropicExtractor();
  let failures = 0;

  for (const { name, expect } of CASES) {
    const transcript = readFileSync(`fixtures/transcripts/${name}.txt`, "utf8");
    const prompt = extractionPrompt({
      transcript,
      personName: PERSON,
      appointmentSpokenTime: SPOKEN_TIME,
    });

    let response = await llm(prompt);
    let result =
      response.stopReason === "end_turn" ? parseExtraction(response.raw) : null;

    // The same one retry run.ts allows, so this script exercises that path too.
    if (!result) {
      console.log(`  (retrying ${name} — first answer could not be read)`);
      response = await llm(`${prompt}\n${STRICTER_NUDGE}`);
      result =
        response.stopReason === "end_turn" ? parseExtraction(response.raw) : null;
    }

    console.log(`\n=== ${name} ===`);
    console.log(`expected: ${expect}`);

    if (!result) {
      failures += 1;
      console.log(`UNREADABLE (stop_reason: ${response.stopReason})`);
      console.log(response.raw);
      continue;
    }

    console.log(`confirmed: ${result.confirmed}`);
    console.log(`new_time:  ${result.newTime}`);
    console.log(`sentiment: ${result.sentiment}`);
    console.log(`summary:   ${result.summary}`);
    console.log(`notes:     ${result.notes}`);
  }

  console.log(
    `\n${CASES.length - failures}/${CASES.length} transcripts read. ` +
      `Judge the values yourself — this script checks that the model answered, ` +
      `not that it answered well.`,
  );

  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Add the npm script**

In `package.json`, beside `try-tools`:

```json
    "try-extraction": "tsx scripts/try-extraction.ts",
```

- [ ] **Step 3: Check it compiles**

Run: `npm run typecheck`
Expected: no errors.

If `tsx` does not resolve the `@/` alias for this script, check how `scripts/try-tools.ts` handles it and match that exactly — do not invent a second convention.

- [ ] **Step 4: Run it, if you have a key**

Run: `npm run try-extraction`
Expected: four blocks printed, `4/4 transcripts read`, and values that match the `expected:` line above each. Skip this step if `ANTHROPIC_API_KEY` is unset — the script will say so clearly.

- [ ] **Step 5: Commit**

```bash
git add scripts/try-extraction.ts package.json
git commit -m "Prove the prompt on a real model, without placing a Call"
```

---

## Task 10: Full suite, lint, and the docs

**Files:**
- Modify: `docs/superpowers/specs/2026-08-21-extraction-pipeline-design.md` (status line)

- [ ] **Step 1: Run everything**

```bash
npm run typecheck
npm run lint
npm test
```

Expected: all green. If `lib/webhooks/process.test.ts` fails on a network call, a `call_analyzed` test was missed in Task 8 step 1 — find it and give it a fake extractor.

- [ ] **Step 2: Mark the design implemented**

In `docs/superpowers/specs/2026-08-21-extraction-pipeline-design.md`, change the status line to:

```markdown
**Status:** Implemented. See `docs/superpowers/plans/2026-08-21-extraction-pipeline.md`
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-08-21-extraction-pipeline-design.md
git commit -m "Mark the Extraction design implemented"
```

---

## Acceptance criteria → where each is proved

| Criterion (issue #14) | Proved by |
|---|---|
| Four pasted transcripts extract correctly with no telephony | `lib/extraction/run.test.ts` "the four transcripts"; `scripts/try-extraction.ts` for the prompt itself |
| A Call where a Tool committed keeps the Tool's outcome | `lib/extraction/outcome.test.ts` "when a Tool committed" — nine cases, three Tools × three contradictions |
| A Call where no Tool ran has its outcome reconstructed | `lib/extraction/outcome.test.ts` "when no Tool committed" |
| Malformed output retries once, then fails softly with the raw response stored | `lib/extraction/run.test.ts` "when the answer cannot be read" |
| Voicemail is taken from the call analysis rather than inferred | `lib/webhooks/payload.test.ts` "call_analysis.in_voicemail"; `run.test.ts` voicemail case |
| A failed extraction never changes an Appointment's status | `lib/extraction/run.test.ts` "never changes the Appointment when it failed" |
