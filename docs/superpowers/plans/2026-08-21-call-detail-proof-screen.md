# Call detail — the proof screen: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `/calls/[id]`, the screen that proves a Call happened and shows exactly what the Agent did — player, two-sided transcript, Outcome card from `tool_invocations`, Extraction card, and designed failure states.

**Architecture:** One server-side loader (`lib/calls/detail.ts`) reads everything in a single pass and hands a plain object to dumb components. Every derivation is a pure function in `lib/calls/` with its own unit test, so the acceptance criteria are proved without mounting a component. One nullable jsonb column, `calls.transcript_turns`, carries Retell's per-turn timestamps; the plain-text transcript stays a permanent fallback.

**Tech Stack:** Next.js 16 App Router (Server Components by default), Drizzle ORM on Postgres, Tailwind 4 with a locked token set in `app/globals.css`, Vitest against a real local Postgres started by `vitest.globalSetup.ts`.

**Design doc:** `docs/superpowers/specs/2026-08-21-call-detail-proof-screen-design.md`

---

## Before you start

Three things about this repo that will otherwise cost you an hour.

**Component tests do not use a testing library.** `environment` is `node`, not
jsdom. `components/schedule/day-grid.test.tsx` renders with
`renderToStaticMarkup` from `react-dom/server` and asserts on the HTML string.
Every component test in this plan does the same. Server Components here are
synchronous functions with no state, so a string of HTML is the whole output.

**The colour, type and radius token sets are closed.** `app/globals.css` sets
`--color-*: initial`, `--text-*: initial` and `--radius-*: initial`, which
deletes Tailwind's stock scales. `bg-blue-500`, `text-lg` and `rounded-xl` do
not exist and will not compile. Use only: colours `bg`, `surface`, `line`,
`text`, `text-muted`, `accent`, `confirmed`, `rescheduled`, `declined`,
`unreachable`, `attention`; text sizes `text-table`, `text-body`,
`text-section`, `text-page`; radii `rounded-card`, `rounded-control`,
`rounded-full`.

**Tailwind scans source text, so class names must be literal strings.** A class
assembled at runtime never gets generated. See the comment in
`lib/appointments/status-style.ts`.

**Commands.** `npm test` (all tests), `npx vitest run <path>` (one file),
`npm run typecheck`, `npm run lint`, `npm run db:generate` (write a migration
from the schema).

---

## File structure

**New pure logic — `lib/calls/`**

| File | Responsibility |
|---|---|
| `duration.ts` | Seconds → `mm:ss` |
| `transcript.ts` | Owns the turn types; parses Retell's `transcript_object`; turns a stored Call into renderable turns, falling back to the plain text |
| `outcome.ts` | Walks `tool_invocations` into the Outcome card's model |
| `no-tools.ts` | The sentence shown when the Agent invoked nothing |
| `failure-reason.ts` | Disconnect reason → sentence + whether Retry is offered |
| `detail.ts` | The one loader: reads the Call, Appointment, invocations and extraction |
| `list.ts` | The `/calls` list query |

**Modified**

| File | Change |
|---|---|
| `lib/db/schema.ts` | Add `transcriptTurns` jsonb to `calls` |
| `lib/webhooks/payload.ts` | Read `call.transcript_object` |
| `lib/webhooks/process.ts` | Write `transcript_turns` under `coalesce` |
| `fixtures/retell/webhooks/call-analyzed.json` | Add `transcript_object` |
| `components/settings/section.tsx` | `SettingsCallout` becomes a re-export of `Callout` |
| `app/(app)/calls/page.tsx` | Placeholder → real list |

**New components — `components/calls/detail/`**

| File | Responsibility |
|---|---|
| `call-header.tsx` | Name, Service, time, status pill, attempt link |
| `recording-player.tsx` | Styled `<audio>` or the waiting panel (client — it owns the time readout) |
| `transcript-panel.tsx` | The two-sided chat list |
| `outcome-card.tsx` | Tool invocations, offered Slots, booked time |
| `extraction-card.tsx` | Notes, summary, sentiment, raw JSON, amber failure branch |
| `failure-card.tsx` | The reason sentence, wrapping the Retry button |
| `retry-call-button.tsx` | Client — calls `useLiveCall().start` |
| `call-detail-poller.tsx` | Client — `router.refresh()` every 5s while anything is outstanding |

**New shared**

| File | Responsibility |
|---|---|
| `components/ui/callout.tsx` | The amber/info/success inline callout, lifted out of Settings |
| `components/calls/call-status-pill.tsx` | A `CallStatus` pill (the existing pill is for `AppointmentStatus`) |
| `app/(app)/calls/[id]/page.tsx` | Assembles the screen |

---

## Task 1: Format a duration

**Files:**
- Create: `lib/calls/duration.ts`
- Test: `lib/calls/duration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/calls/duration.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { formatDuration } from "@/lib/calls/duration";

/*
  Used by the player, the transcript's turn stamps, the header and the Calls
  list. All four render in mono and sit in a column, so a stray `1:5` breaks the
  alignment SPEC.md §11.2 asks for — which is the whole reason this is a shared
  function rather than four call sites doing their own arithmetic.
*/

describe("formatDuration", () => {
  it("pads both halves to two digits", () => {
    expect(formatDuration(65)).toBe("01:05");
  });

  it("renders zero as zero, not as an em-dash", () => {
    expect(formatDuration(0)).toBe("00:00");
  });

  it("carries past an hour without inventing an hours field", () => {
    expect(formatDuration(3661)).toBe("61:01");
  });

  it("gives an em-dash for a duration nobody has reported yet", () => {
    expect(formatDuration(null)).toBe("—");
  });

  it("floors a fractional second rather than showing a decimal", () => {
    expect(formatDuration(65.9)).toBe("01:05");
  });

  it("treats a negative as zero", () => {
    expect(formatDuration(-5)).toBe("00:00");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/calls/duration.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/calls/duration"`.

- [ ] **Step 3: Write the implementation**

Create `lib/calls/duration.ts`:

```ts
/**
 * Seconds as `mm:ss`, for every mono time on the Call detail screen.
 *
 * Both halves are padded, always. The player's readout, the transcript's turn
 * stamps, the header's duration and the Calls list all render in mono and stack
 * into a column, so one unpadded `1:5` misaligns the lot.
 *
 * Minutes are not carried into hours. A Call is capped at 120 seconds by
 * `max_call_duration_ms` (SPEC.md §7), so an hours field would be a column that
 * is always `00:` — and `61:01` is the honest rendering of a recording that
 * somehow ran long.
 *
 * Null is an em-dash rather than `00:00`, because "Retell has not told us the
 * duration yet" and "the Call lasted no time at all" are different facts and
 * the screen shows both.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) {
    return "—";
  }

  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;

  return `${pad(minutes)}:${pad(rest)}`;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/calls/duration.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/calls/duration.ts lib/calls/duration.test.ts
git commit -m "Pad every mono time the same way"
```

---

## Task 2: Read a transcript out of the plain text

**Files:**
- Create: `lib/calls/transcript.ts`
- Test: `lib/calls/transcript.test.ts`

This task builds only the fallback path. Task 3 adds the stamped path on top.

- [ ] **Step 1: Write the failing test**

Create `lib/calls/transcript.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { callTranscript } from "@/lib/calls/transcript";

/*
  The fallback path, which is not only for rows written before
  `transcript_turns` existed.

  `call_ended` carries the text transcript and `call_analyzed` carries the
  object, minutes apart (docs/verification.md A9). So every Call has a real
  window in which the plain text is the only transcript there is, and this is
  what renders during it.
*/

const CONFIRM = [
  "Agent: Hi Priya, this is Maya from Bloom Salon.",
  "User: Hello.",
  "Agent: Does Thursday at nine still work?",
  "User: Yes, that's fine.",
].join("\n");

describe("callTranscript, from the plain text", () => {
  it("splits Agent and User lines into two-sided turns", () => {
    const turns = callTranscript({ transcriptTurns: null, transcript: CONFIRM });

    expect(turns).toHaveLength(4);
    expect(turns[0]).toEqual({
      speaker: "agent",
      text: "Hi Priya, this is Maya from Bloom Salon.",
      startSeconds: null,
    });
    expect(turns[1].speaker).toBe("person");
  });

  it("leaves every turn unstamped rather than guessing a time", () => {
    const turns = callTranscript({ transcriptTurns: null, transcript: CONFIRM });

    expect(turns.every((turn) => turn.startSeconds === null)).toBe(true);
  });

  it("joins an unprefixed line onto the turn above it", () => {
    const turns = callTranscript({
      transcriptTurns: null,
      transcript: "Agent: One sentence.\nAnd its continuation.\nUser: Fine.",
    });

    expect(turns).toHaveLength(2);
    expect(turns[0].text).toBe("One sentence. And its continuation.");
  });

  it("drops an unprefixed line that has no turn to join", () => {
    const turns = callTranscript({
      transcriptTurns: null,
      transcript: "Stray opening line.\nAgent: Hello.",
    });

    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("Hello.");
  });

  it("ignores blank lines and trailing newlines", () => {
    const turns = callTranscript({
      transcriptTurns: null,
      transcript: "Agent: Hello.\n\nUser: Hi.\n",
    });

    expect(turns).toHaveLength(2);
  });

  it("returns nothing for a Call with no transcript at all", () => {
    expect(callTranscript({ transcriptTurns: null, transcript: null })).toEqual([]);
    expect(callTranscript({ transcriptTurns: null, transcript: "" })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/calls/transcript.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/calls/transcript"`.

- [ ] **Step 3: Write the implementation**

Create `lib/calls/transcript.ts`:

```ts
/*
  Everything that turns a stored Call into a transcript on screen.

  Two sources, one output. `calls.transcript_turns` holds Retell's
  `transcript_object` and carries a start time per turn;
  `calls.transcript` holds the plain text and carries none. This module owns
  both directions — the parser that reads Retell's shape on the way in, and the
  reader that turns either column into renderable turns on the way out — so the
  two can never drift into disagreeing about what a turn is.
*/

/** Which side of the conversation a turn belongs to. */
export type Speaker = "agent" | "person";

/**
 * One turn as it is stored in `calls.transcript_turns`.
 *
 * Retell's vocabulary, kept deliberately: `role` here is `agent` or `user`,
 * matching the payload, so a stored row can be read back against Retell's own
 * docs without a translation table. The translation to `Speaker` happens once,
 * on the way to the screen.
 *
 * The word-level timings Retell also sends are dropped. Nothing on this screen
 * highlights individual words, and keeping them would multiply the column's
 * size by roughly the word count for no reader.
 */
export type StoredTurn = {
  role: "agent" | "user";
  content: string;
  /** Seconds from the start of the recording, or null if Retell gave none. */
  startSeconds: number | null;
};

/** One turn as the screen renders it. */
export type TranscriptTurn = {
  speaker: Speaker;
  text: string;
  startSeconds: number | null;
};

export type CallTranscriptInput = {
  /** The `calls.transcript_turns` jsonb column, unvalidated. */
  transcriptTurns: unknown;
  /** The `calls.transcript` text column. */
  transcript: string | null;
};

/**
 * The transcript to render, from whichever column has one.
 *
 * Stamped turns win. The plain text is the fallback, and it is a permanent one
 * rather than a migration artefact — see the note at the top of
 * `lib/calls/transcript.test.ts`.
 */
export function callTranscript({
  transcriptTurns,
  transcript,
}: CallTranscriptInput): TranscriptTurn[] {
  const stored = readStoredTurns(transcriptTurns);
  if (stored && stored.length > 0) {
    return stored.map((turn) => ({
      speaker: turn.role === "agent" ? "agent" : "person",
      text: turn.content,
      startSeconds: turn.startSeconds,
    }));
  }

  return fromPlainText(transcript);
}

/**
 * Validate the jsonb column on the way back out.
 *
 * Anything unrecognised yields null, which means "we have no turns" and sends
 * the caller to the plain text. Same contract, and the same reasoning, as
 * `offeredSlotsInCall` in lib/tools/offers.ts: `result` and `transcript_turns`
 * are both jsonb, and a column an older version of this code wrote must not be
 * able to throw inside a page render.
 */
export function readStoredTurns(value: unknown): StoredTurn[] | null {
  if (!Array.isArray(value)) return null;

  const turns: StoredTurn[] = [];

  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;

    const { role, content, startSeconds } = entry as Record<string, unknown>;
    if (role !== "agent" && role !== "user") continue;
    if (typeof content !== "string" || content === "") continue;

    turns.push({
      role,
      content,
      startSeconds: typeof startSeconds === "number" ? startSeconds : null,
    });
  }

  return turns.length > 0 ? turns : null;
}

/** Retell's own prefixes, exactly as they appear in `call.transcript`. */
const PREFIXES: ReadonlyArray<{ prefix: string; speaker: Speaker }> = [
  { prefix: "Agent:", speaker: "agent" },
  { prefix: "User:", speaker: "person" },
];

/**
 * Split `Agent: ...\nUser: ...` into turns.
 *
 * A line with no prefix joins the turn above it rather than being dropped. A
 * transcript missing a sentence is worse than an ugly one, and Retell does emit
 * wrapped lines. A line with no prefix and no turn above it has nowhere to go
 * and is dropped — it is preamble, not speech.
 */
function fromPlainText(transcript: string | null): TranscriptTurn[] {
  if (!transcript) return [];

  const turns: TranscriptTurn[] = [];

  for (const rawLine of transcript.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;

    const match = PREFIXES.find(({ prefix }) => line.startsWith(prefix));

    if (match) {
      turns.push({
        speaker: match.speaker,
        text: line.slice(match.prefix.length).trim(),
        startSeconds: null,
      });
      continue;
    }

    const previous = turns.at(-1);
    if (previous) previous.text = `${previous.text} ${line}`.trim();
  }

  return turns.filter((turn) => turn.text !== "");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/calls/transcript.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/calls/transcript.ts lib/calls/transcript.test.ts
git commit -m "Read a two-sided transcript out of Retell's plain text"
```

---

## Task 3: Parse Retell's transcript_object

**Files:**
- Modify: `lib/calls/transcript.ts` (add `parseTranscriptObject`)
- Test: `lib/calls/transcript.test.ts` (add a describe block)

- [ ] **Step 1: Write the failing test**

Append to `lib/calls/transcript.test.ts` — and add `parseTranscriptObject` to
the import at the top of the file so it reads:

```ts
import { callTranscript, parseTranscriptObject } from "@/lib/calls/transcript";
```

Then append:

```ts
/*
  Retell's shape, from docs/verification.md A9: an array of
  `{ role, content, words: [{ word, start, end }] }`. A turn's start time is its
  first word's, because that is when the person began speaking.

  Null on anything malformed, never a throw. This runs inside the webhook
  handler, and #13's whole design is that a surprising payload costs us a field
  and never costs us the delivery.
*/

const RETELL_OBJECT = [
  {
    role: "agent",
    content: "Hi Priya, this is Maya.",
    words: [
      { word: "Hi", start: 0.4, end: 0.6 },
      { word: "Priya,", start: 0.6, end: 0.9 },
    ],
  },
  {
    role: "user",
    content: "Hello.",
    words: [{ word: "Hello.", start: 3.2, end: 3.6 }],
  },
];

describe("parseTranscriptObject", () => {
  it("takes each turn's start time from its first word", () => {
    expect(parseTranscriptObject(RETELL_OBJECT)).toEqual([
      { role: "agent", content: "Hi Priya, this is Maya.", startSeconds: 0.4 },
      { role: "user", content: "Hello.", startSeconds: 3.2 },
    ]);
  });

  it("keeps a turn that has no words, unstamped", () => {
    expect(parseTranscriptObject([{ role: "agent", content: "Hello." }])).toEqual([
      { role: "agent", content: "Hello.", startSeconds: null },
    ]);
  });

  it("skips a turn whose role is not one Retell documents", () => {
    const parsed = parseTranscriptObject([
      { role: "system", content: "Ignore me." },
      { role: "user", content: "Keep me." },
    ]);

    expect(parsed).toEqual([
      { role: "user", content: "Keep me.", startSeconds: null },
    ]);
  });

  it("returns null rather than throwing on anything that is not an array", () => {
    expect(parseTranscriptObject(undefined)).toBeNull();
    expect(parseTranscriptObject(null)).toBeNull();
    expect(parseTranscriptObject("Agent: hello")).toBeNull();
    expect(parseTranscriptObject({ turns: [] })).toBeNull();
  });

  it("returns null when nothing in the array survives validation", () => {
    expect(parseTranscriptObject([{ role: "system", content: "x" }])).toBeNull();
    expect(parseTranscriptObject([])).toBeNull();
  });
});

describe("callTranscript, from the stored turns", () => {
  it("prefers the stamped turns over the plain text", () => {
    const turns = callTranscript({
      transcriptTurns: parseTranscriptObject(RETELL_OBJECT),
      transcript: "Agent: Something else entirely.",
    });

    expect(turns).toEqual([
      { speaker: "agent", text: "Hi Priya, this is Maya.", startSeconds: 0.4 },
      { speaker: "person", text: "Hello.", startSeconds: 3.2 },
    ]);
  });

  it("falls back to the plain text when the column holds something unusable", () => {
    const turns = callTranscript({
      transcriptTurns: { not: "an array" },
      transcript: "Agent: Hello.",
    });

    expect(turns).toEqual([
      { speaker: "agent", text: "Hello.", startSeconds: null },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/calls/transcript.test.ts`
Expected: FAIL — `parseTranscriptObject is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `lib/calls/transcript.ts`:

```ts
/**
 * Retell's `call.transcript_object`, read down to what this screen renders.
 *
 * The shape is an array of `{ role, content, words: [{ word, start, end }] }`
 * (docs/verification.md A9). A turn's start time is its first word's — that is
 * the moment the speaker began.
 *
 * Null on anything malformed rather than a thrown error, matching every other
 * reader in `lib/webhooks/payload.ts`. This runs inside the webhook handler, and
 * a surprising payload must cost us timestamps and never cost us the delivery.
 * Null sends the screen to the plain-text transcript, which is already there.
 */
export function parseTranscriptObject(value: unknown): StoredTurn[] | null {
  if (!Array.isArray(value)) return null;

  const turns: StoredTurn[] = [];

  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;

    const { role, content, words } = entry as Record<string, unknown>;
    if (role !== "agent" && role !== "user") continue;
    if (typeof content !== "string" || content === "") continue;

    turns.push({ role, content, startSeconds: firstWordStart(words) });
  }

  return turns.length > 0 ? turns : null;
}

function firstWordStart(words: unknown): number | null {
  if (!Array.isArray(words)) return null;

  for (const word of words) {
    if (typeof word !== "object" || word === null) continue;

    const { start } = word as Record<string, unknown>;
    if (typeof start === "number" && Number.isFinite(start)) return start;
  }

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/calls/transcript.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/calls/transcript.ts lib/calls/transcript.test.ts
git commit -m "Take per-turn timestamps from Retell rather than guessing them"
```

---

## Task 4: Add the transcript_turns column

**Files:**
- Modify: `lib/db/schema.ts:204` (the `calls` table)
- Create: `drizzle/0004_*.sql` (generated)

- [ ] **Step 1: Add the column to the schema**

In `lib/db/schema.ts`, import the turn type at the top of the file, beside the
existing imports:

```ts
import type { StoredTurn } from "@/lib/calls/transcript";
```

Then, in the `calls` table, immediately after the `transcript` line, add:

```ts
    /*
      Retell's `transcript_object`, kept as `{ role, content, startSeconds }` per
      turn — see `parseTranscriptObject` in lib/calls/transcript.ts for what is
      dropped and why.

      Nullable, and permanently so. It arrives on `call_analyzed` while the plain
      `transcript` above arrives on `call_ended`, so every Call has a window in
      which this is null and the text column is the only transcript there is.
      Nothing on the Call detail screen may require this column.
    */
    transcriptTurns: jsonb("transcript_turns").$type<StoredTurn[]>(),
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`
Expected: a new file `drizzle/0004_<random-name>.sql` containing
`ALTER TABLE "calls" ADD COLUMN "transcript_turns" jsonb;`, plus an updated
`drizzle/meta/` snapshot.

- [ ] **Step 3: Read the generated SQL and confirm it is only the one column**

Run: `cat drizzle/0004_*.sql`
Expected: a single `ALTER TABLE ... ADD COLUMN` statement. If drizzle-kit has
generated anything that drops or alters an existing column, stop — the schema
file has drifted from the database and that is a separate problem.

- [ ] **Step 4: Run the whole suite to confirm nothing broke**

Run: `npm test`
Expected: PASS. `vitest.globalSetup.ts` applies migrations to the local test
cluster, so the new column exists for every DB test.

- [ ] **Step 5: Commit**

```bash
git add lib/db/schema.ts drizzle/
git commit -m "Give calls a column for Retell's per-turn timings"
```

---

## Task 5: Read transcript_object off the payload

**Files:**
- Modify: `lib/webhooks/payload.ts`
- Test: `lib/webhooks/payload.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `lib/webhooks/payload.test.ts`:

```ts
describe("transcript_object", () => {
  /*
    The field only rides on `call_analyzed` (docs/verification.md A9). Absent on
    the other two events, which is not an error — it is null, meaning "Retell did
    not say", exactly like `in_voicemail`.
  */

  it("is read into transcriptTurns when present", () => {
    const event = parseWebhookPayload(
      JSON.stringify({
        event: "call_analyzed",
        call: {
          call_id: "call_abc",
          transcript_object: [
            {
              role: "agent",
              content: "Hi Priya.",
              words: [{ word: "Hi", start: 0.4, end: 0.6 }],
            },
          ],
        },
      }),
    );

    expect(event?.transcriptTurns).toEqual([
      { role: "agent", content: "Hi Priya.", startSeconds: 0.4 },
    ]);
  });

  it("is null when the event does not carry one", () => {
    const event = parseWebhookPayload(
      JSON.stringify({ event: "call_started", call: { call_id: "call_abc" } }),
    );

    expect(event?.transcriptTurns).toBeNull();
  });

  it("is null, and the delivery still parses, when the field is garbage", () => {
    const event = parseWebhookPayload(
      JSON.stringify({
        event: "call_analyzed",
        call: {
          call_id: "call_abc",
          transcript: "Agent: Hi Priya.",
          transcript_object: "not an array",
        },
      }),
    );

    expect(event).not.toBeNull();
    expect(event?.transcriptTurns).toBeNull();
    expect(event?.transcript).toBe("Agent: Hi Priya.");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/webhooks/payload.test.ts`
Expected: FAIL — `transcriptTurns` does not exist on the returned type, so this
fails at typecheck, and at runtime the value is `undefined` rather than `null`.

- [ ] **Step 3: Write the implementation**

In `lib/webhooks/payload.ts`, add the import at the top:

```ts
import { parseTranscriptObject, type StoredTurn } from "@/lib/calls/transcript";
```

Add the field to the `WebhookEvent` type, directly beneath `transcript`:

```ts
  /**
   * `call.transcript_object`, reduced to one start time per turn.
   *
   * Only `call_analyzed` carries it, so it is null on the other two events — and
   * null means "Retell did not say", never "there were no turns". The screen
   * falls back to `transcript` above, which arrives a whole event earlier.
   */
  transcriptTurns: StoredTurn[] | null;
```

And add the field to the returned object, directly beneath the `transcript` line:

```ts
    transcriptTurns: parseTranscriptObject(call.transcript_object),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/webhooks/payload.test.ts`
Expected: PASS, including the three new tests.

- [ ] **Step 5: Commit**

```bash
git add lib/webhooks/payload.ts lib/webhooks/payload.test.ts
git commit -m "Read Retell's transcript_object off the delivery"
```

---

## Task 6: Write transcript_turns, and prove it by replay

**Files:**
- Modify: `lib/webhooks/process.ts` (`applyAnalyzed`, around line 137)
- Modify: `fixtures/retell/webhooks/call-analyzed.json`
- Test: `lib/webhooks/process.test.ts`

- [ ] **Step 1: Add the turns to the fixture**

In `fixtures/retell/webhooks/call-analyzed.json`, add a `transcript_object` key
to the `call` object, immediately after `transcript`. The turns must match the
`transcript` string already in that file — a fixture that disagrees with itself
is worse than no fixture:

```json
    "transcript_object": [
      {
        "role": "agent",
        "content": "Hi Priya, this is Maya calling from Bloom Salon about your haircut on Thursday at 9 in the morning. Does that still work for you?",
        "words": [{ "word": "Hi", "start": 0.32, "end": 0.51 }]
      },
      {
        "role": "user",
        "content": "Actually no, Thursday morning is bad for me now.",
        "words": [{ "word": "Actually", "start": 9.14, "end": 9.62 }]
      },
      {
        "role": "agent",
        "content": "No problem. I have Thursday at four in the afternoon, or Friday at eleven.",
        "words": [{ "word": "No", "start": 12.05, "end": 12.21 }]
      },
      {
        "role": "user",
        "content": "Four on Thursday is perfect.",
        "words": [{ "word": "Four", "start": 18.44, "end": 18.79 }]
      },
      {
        "role": "agent",
        "content": "Lovely, you're booked for Thursday at four in the afternoon. See you then!",
        "words": [{ "word": "Lovely,", "start": 21.10, "end": 21.55 }]
      },
      {
        "role": "user",
        "content": "Thanks, bye.",
        "words": [{ "word": "Thanks,", "start": 26.02, "end": 26.38 }]
      }
    ],
```

- [ ] **Step 2: Write the failing test**

Append to `lib/webhooks/process.test.ts`. The file already has a file-level
`seed` with its own `beforeEach`/`afterEach`, and an `event(type, call)` helper
that builds a delivery by running a real payload through `parseWebhookPayload`.
Use both — building a `WebhookEvent` by hand would skip the parser this feature
just changed.

```ts
describe("transcript_turns", () => {
  /*
    Written under `coalesce`, like `transcript` and `recording_url` beside it.
    Retell retries a delivery up to three times on a 10-second timeout, so a
    second `call_analyzed` arriving after the first has already landed must be a
    no-op rather than a rewrite.
  */

  /** Retell's shape, which `event()` will run through the real parser. */
  const RETELL_TURNS = [
    {
      role: "agent",
      content: "Hi Priya.",
      words: [{ word: "Hi", start: 0.4, end: 0.6 }],
    },
  ];

  /** The same thing, as it should land in the column. */
  const STORED_TURNS = [
    { role: "agent", content: "Hi Priya.", startSeconds: 0.4 },
  ];

  async function storedTurns() {
    const [row] = await db
      .select({ transcriptTurns: schema.calls.transcriptTurns })
      .from(schema.calls)
      .where(eq(schema.calls.id, seed.callId));

    return row.transcriptTurns;
  }

  it("writes the turns the delivery carried", async () => {
    await processWebhookEvent(
      event("call_analyzed", { transcript_object: RETELL_TURNS }),
    );

    expect(await storedTurns()).toEqual(STORED_TURNS);
  });

  it("does not blank them when a later delivery carries none", async () => {
    await processWebhookEvent(
      event("call_analyzed", { transcript_object: RETELL_TURNS }),
    );
    await processWebhookEvent(
      event("call_analyzed", { transcript: "Agent: Hi Priya." }),
    );

    expect(await storedTurns()).toEqual(STORED_TURNS);
  });

  it("does not overwrite turns an earlier delivery already wrote", async () => {
    await processWebhookEvent(
      event("call_analyzed", { transcript_object: RETELL_TURNS }),
    );
    await processWebhookEvent(
      event("call_analyzed", {
        transcript_object: [
          { role: "agent", content: "Different.", words: [{ word: "Different.", start: 9 }] },
        ],
      }),
    );

    expect(await storedTurns()).toEqual(STORED_TURNS);
  });
});
```

Note: `processWebhookEvent` runs Extraction on `call_analyzed`. The existing
tests in this file already handle that by passing a fake `ExtractionLlm` — if
these three fail with an Anthropic error rather than an assertion, copy the
extractor argument from the `call_analyzed` tests directly above.

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run lib/webhooks/process.test.ts`
Expected: FAIL — `storedTurns()` returns `null` on the first test, because
nothing writes the column yet.

- [ ] **Step 4: Write the implementation**

In `lib/webhooks/process.ts`, inside `applyAnalyzed`:

Change the guard so the turns can trigger a write on their own:

```ts
  if (event.transcript || event.recordingUrl || event.transcriptTurns) {
```

And add a third branch inside the `.set({ ... })`, beside the two that are
already there:

```ts
        ...(event.transcriptTurns
          ? {
              transcriptTurns: sql`coalesce(${schema.calls.transcriptTurns}, ${JSON.stringify(event.transcriptTurns)}::jsonb)`,
            }
          : {}),
```

Note the explicit `::jsonb` cast. Drizzle binds the stringified array as `text`,
and `coalesce(jsonb, text)` is a type error in Postgres — the cast is what makes
the two arms of the `coalesce` the same type.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run lib/webhooks/process.test.ts`
Expected: PASS, including the three new tests.

- [ ] **Step 6: Prove it through the real pipeline**

The unit test above calls `processWebhookEvent` directly. The replay script
signs a real request and drives the whole handler, which is the thing that
proves the fixture, the signature check, the parser and the write agree.

Run: `npm run replay-webhook`
Expected: the script completes with no failures, exactly as it did before this
change.

Then confirm the column was actually populated by the replayed delivery rather
than by a test:

Run: `npm run db:studio` and read `calls.transcript_turns` on the row the replay
just drove — or, faster, add a one-line `console.log` of the column at the end
of `scripts/replay-webhook.ts`, run it, and remove the line.

- [ ] **Step 7: Commit**

```bash
git add lib/webhooks/process.ts lib/webhooks/process.test.ts fixtures/retell/webhooks/call-analyzed.json
git commit -m "Store the per-turn timings a redelivery must not blank"
```

---

## Task 7: Build the Outcome card's model

**Files:**
- Create: `lib/calls/outcome.ts`
- Test: `lib/calls/outcome.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/calls/outcome.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { callOutcome, type InvocationRow } from "@/lib/calls/outcome";

/*
  The card that is the point of the whole screen: what the Agent DID, from
  `tool_invocations`, not what an LLM said about it afterwards (SPEC.md §9
  step 3).

  The rule that matters most here is that a failed invocation stays in the list,
  in place. A `book_slot` that failed is the most interesting row the card can
  hold — it is the moment Maya told somebody a time and Callzie could not honour
  it — and a card that quietly dropped it would be undoing the product's central
  claim.
*/

const AT = (seconds: number) => new Date(2026, 7, 21, 9, 0, seconds);

const CHECK = (slots: { slot_start: string; time: string }[], seconds: number): InvocationRow => ({
  id: `check-${seconds}`,
  toolName: "check_availability",
  arguments: {},
  result: { ok: true, slots },
  succeeded: true,
  latencyMs: 120,
  createdAt: AT(seconds),
});

const THURSDAY_4PM = { slot_start: "2026-08-27T10:30:00.000Z", time: "Thursday at four in the afternoon" };
const FRIDAY_11AM = { slot_start: "2026-08-28T05:30:00.000Z", time: "Friday at eleven in the morning" };

describe("callOutcome", () => {
  it("keeps a failed invocation in the list, in order", () => {
    const outcome = callOutcome([
      CHECK([THURSDAY_4PM], 1),
      {
        id: "book-fail",
        toolName: "book_slot",
        arguments: { slot_start: THURSDAY_4PM.slot_start },
        result: { ok: false, reason: "slot_taken" },
        succeeded: false,
        latencyMs: 340,
        createdAt: AT(2),
      },
    ]);

    expect(outcome.invocations).toHaveLength(2);
    expect(outcome.invocations[1].succeeded).toBe(false);
    expect(outcome.invocations[1].toolName).toBe("book_slot");
  });

  it("orders invocations by when they ran, not by how they arrived", () => {
    const outcome = callOutcome([CHECK([FRIDAY_11AM], 9), CHECK([THURSDAY_4PM], 1)]);

    expect(outcome.invocations.map((row) => row.id)).toEqual(["check-1", "check-9"]);
  });

  it("collects the offered Slots across every check, deduped, in first-seen order", () => {
    const outcome = callOutcome([
      CHECK([THURSDAY_4PM, FRIDAY_11AM], 1),
      CHECK([FRIDAY_11AM], 5),
    ]);

    expect(outcome.offeredSlots).toEqual([THURSDAY_4PM, FRIDAY_11AM]);
  });

  it("ignores the Slots of a check that failed", () => {
    const outcome = callOutcome([
      { ...CHECK([THURSDAY_4PM], 1), succeeded: false },
    ]);

    expect(outcome.offeredSlots).toEqual([]);
  });

  it("reports the time a successful book_slot committed", () => {
    const outcome = callOutcome([
      CHECK([THURSDAY_4PM], 1),
      {
        id: "book-ok",
        toolName: "book_slot",
        arguments: { slot_start: THURSDAY_4PM.slot_start },
        result: { ok: true, booked_time: "Thursday at four in the afternoon" },
        succeeded: true,
        latencyMs: 410,
        createdAt: AT(2),
      },
    ]);

    expect(outcome.bookedTime).toBe("Thursday at four in the afternoon");
  });

  it("reports no booked time when the booking failed", () => {
    const outcome = callOutcome([
      {
        id: "book-fail",
        toolName: "book_slot",
        arguments: {},
        result: { ok: false, reason: "slot_taken" },
        succeeded: false,
        latencyMs: 340,
        createdAt: AT(2),
      },
    ]);

    expect(outcome.bookedTime).toBeNull();
  });

  it("says a Tool committed when confirm_appointment succeeded", () => {
    const outcome = callOutcome([
      {
        id: "confirm",
        toolName: "confirm_appointment",
        arguments: {},
        result: { ok: true },
        succeeded: true,
        latencyMs: 90,
        createdAt: AT(3),
      },
    ]);

    expect(outcome.aToolCommitted).toBe(true);
  });

  it("says no Tool committed when only check_availability ran", () => {
    const outcome = callOutcome([CHECK([THURSDAY_4PM], 1)]);

    expect(outcome.aToolCommitted).toBe(false);
  });

  it("survives a result of a shape nobody expected", () => {
    const outcome = callOutcome([
      { ...CHECK([], 1), result: "this should have been an object" },
    ]);

    expect(outcome.offeredSlots).toEqual([]);
    expect(outcome.invocations).toHaveLength(1);
  });

  it("returns an empty model for a Call where nothing ran", () => {
    const outcome = callOutcome([]);

    expect(outcome).toEqual({
      invocations: [],
      offeredSlots: [],
      bookedTime: null,
      aToolCommitted: false,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/calls/outcome.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/calls/outcome"`.

- [ ] **Step 3: Write the implementation**

Create `lib/calls/outcome.ts`:

```ts
import type { ToolName } from "@/lib/db/schema";
import type { OfferedSlot } from "@/lib/tools/offers";

/*
  The Outcome card's model, built from `tool_invocations`.

  This is the authoritative record of what happened on a Call (SPEC.md §9
  step 3), and it is deliberately built from the rows the Tool endpoints wrote
  mid-Call rather than from `extractions`, which is only what was said
  afterwards. When the two disagree, this wins — on the screen as well as in
  `lib/extraction/outcome.ts`.

  Everything here is defensive about `arguments` and `result`, which are jsonb.
  A row written by an older version of a Tool must not be able to throw inside a
  page render — the same contract `offeredSlotsInCall` in lib/tools/offers.ts
  states for the same columns.
*/

/** One `tool_invocations` row, as the loader reads it. */
export type InvocationRow = {
  id: string;
  toolName: ToolName;
  arguments: unknown;
  result: unknown;
  succeeded: boolean;
  latencyMs: number | null;
  createdAt: Date;
};

export type CallOutcome = {
  /** Every invocation, in the order it ran. Failures included, in place. */
  invocations: InvocationRow[];
  /** Every Slot this Call actually named, deduped, in first-seen order. */
  offeredSlots: OfferedSlot[];
  /** What a successful `book_slot` read back to the person, or null. */
  bookedTime: string | null;
  /**
   * Did any Tool write an outcome?
   *
   * The same question `aToolCommitted` in lib/extraction/outcome.ts asks of the
   * database, answered here from rows already in hand. `check_availability` is
   * not one of these: it is a read, and a Call where Maya only ever checked
   * times is a Call where no Tool committed.
   */
  aToolCommitted: boolean;
};

const COMMITTING_TOOLS: readonly ToolName[] = [
  "book_slot",
  "confirm_appointment",
  "cancel_appointment",
];

export function callOutcome(rows: InvocationRow[]): CallOutcome {
  const invocations = [...rows].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );

  const offeredSlots: OfferedSlot[] = [];
  const seen = new Set<string>();
  let bookedTime: string | null = null;
  let aToolCommitted = false;

  for (const row of invocations) {
    if (row.succeeded && COMMITTING_TOOLS.includes(row.toolName)) {
      aToolCommitted = true;
    }

    // A check that failed offered nothing, whatever is in its result.
    if (row.toolName === "check_availability" && row.succeeded) {
      for (const slot of slotsIn(row.result)) {
        if (seen.has(slot.slot_start)) continue;
        seen.add(slot.slot_start);
        offeredSlots.push(slot);
      }
    }

    if (row.toolName === "book_slot" && row.succeeded) {
      bookedTime = bookedTimeIn(row.result) ?? bookedTime;
    }
  }

  return { invocations, offeredSlots, bookedTime, aToolCommitted };
}

/** `check_availability`'s `{ ok: true, slots: [{ slot_start, time }] }`. */
function slotsIn(result: unknown): OfferedSlot[] {
  if (typeof result !== "object" || result === null) return [];

  const { slots } = result as Record<string, unknown>;
  if (!Array.isArray(slots)) return [];

  const offered: OfferedSlot[] = [];

  for (const slot of slots) {
    if (typeof slot !== "object" || slot === null) continue;

    const { slot_start, time } = slot as Record<string, unknown>;
    if (typeof slot_start !== "string" || slot_start === "") continue;

    offered.push({ slot_start, time: typeof time === "string" ? time : slot_start });
  }

  return offered;
}

/** `book_slot`'s `{ ok: true, booked_time }` — the spoken form, not the ISO one. */
function bookedTimeIn(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;

  const { booked_time } = result as Record<string, unknown>;
  return typeof booked_time === "string" && booked_time !== "" ? booked_time : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/calls/outcome.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/calls/outcome.ts lib/calls/outcome.test.ts
git commit -m "Keep the failed book_slot in the record it belongs in"
```

---

## Task 8: Say something when the Agent invoked nothing

**Files:**
- Create: `lib/calls/no-tools.ts`
- Test: `lib/calls/no-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/calls/no-tools.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { noToolsSummary, type NoToolsInput } from "@/lib/calls/no-tools";

/*
  The Outcome card's empty state, which must never render blank — that is an
  acceptance criterion on issue #16, and a blank card on the screen whose whole
  job is showing what happened is the worst possible version of this.

  There are five different reasons a Call has no Tool invocations, and they mean
  five different things. Telling them apart is the entire module.

  One ordering matters and is not arbitrary: `newTime` outranks `confirmed`,
  matching `fallbackChange` in lib/extraction/outcome.ts. Somebody who named a
  new time did not agree to the old one, whatever else came back in the same
  object — and the two files must agree, or the card says "confirmed" about an
  Appointment the extraction moved to Needs Attention.
*/

const BASE: NoToolsInput = {
  callStatus: "completed",
  personName: "Priya",
  extraction: null,
};

const extraction = (over: Partial<NonNullable<NoToolsInput["extraction"]>> = {}) => ({
  status: "ok" as const,
  inVoicemail: false,
  confirmed: null,
  newTime: null,
  ...over,
});

describe("noToolsSummary", () => {
  it("defers to the failure card when the Call never connected", () => {
    const summary = noToolsSummary({ ...BASE, callStatus: "no_answer" });

    expect(summary.headline).toBe("Nothing to do — the Call did not connect");
    expect(summary.detail).toContain("reason");
  });

  it("says the analysis has not landed yet when there is no extraction row", () => {
    const summary = noToolsSummary(BASE);

    expect(summary.headline).toBe("Maya invoked no Tools");
    expect(summary.detail).toContain("still being analysed");
  });

  it("points at the amber card when the extraction failed", () => {
    const summary = noToolsSummary({
      ...BASE,
      extraction: extraction({ status: "failed" }),
    });

    expect(summary.headline).toBe("Maya invoked no Tools");
    expect(summary.detail).toContain("extraction failed");
  });

  it("says a machine picked up when Retell reported voicemail", () => {
    const summary = noToolsSummary({
      ...BASE,
      extraction: extraction({ inVoicemail: true }),
    });

    expect(summary.headline).toBe("A machine picked up");
    expect(summary.detail).toContain("voicemail");
  });

  it("reports a new time above everything else, and says it was not booked", () => {
    const summary = noToolsSummary({
      ...BASE,
      extraction: extraction({ confirmed: true, newTime: "Friday afternoon" }),
    });

    expect(summary.headline).toBe("Priya asked for a different time");
    expect(summary.detail).toContain("Friday afternoon");
    expect(summary.detail).toContain("not booked");
  });

  it("reports a confirmation from the fallback fields", () => {
    const summary = noToolsSummary({
      ...BASE,
      extraction: extraction({ confirmed: true }),
    });

    expect(summary.headline).toBe("Priya confirmed, without a Tool");
  });

  it("reports a decline from the fallback fields", () => {
    const summary = noToolsSummary({
      ...BASE,
      extraction: extraction({ confirmed: false }),
    });

    expect(summary.headline).toBe("Priya declined, without a Tool");
  });

  it("admits nothing was decided when the fallback fields are empty too", () => {
    const summary = noToolsSummary({ ...BASE, extraction: extraction() });

    expect(summary.headline).toBe("Nothing was decided");
    expect(summary.detail).toContain("Priya");
  });

  it("never returns an empty string for either field", () => {
    const statuses = ["completed", "no_answer", "failed", "in_progress"] as const;

    for (const callStatus of statuses) {
      const summary = noToolsSummary({ ...BASE, callStatus });
      expect(summary.headline.length).toBeGreaterThan(0);
      expect(summary.detail.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/calls/no-tools.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/calls/no-tools"`.

- [ ] **Step 3: Write the implementation**

Create `lib/calls/no-tools.ts`:

```ts
import type { CallStatus, ExtractionStatus } from "@/lib/db/schema";

/*
  What the Outcome card says when `tool_invocations` is empty.

  Rendering nothing is not an option — issue #16 asks for this explicitly, and a
  blank card on the proof screen reads as a broken product rather than as a Call
  where nothing happened.

  Five situations, five sentences. The order of the checks below is the whole
  design: each one is only reached because the ones above it did not apply.
*/

export type NoToolsInput = {
  callStatus: CallStatus;
  /** From the Appointment, so the sentence names a person rather than "the caller". */
  personName: string;
  extraction: {
    status: ExtractionStatus;
    inVoicemail: boolean | null;
    confirmed: boolean | null;
    newTime: string | null;
  } | null;
};

export type NoToolsSummary = {
  headline: string;
  detail: string;
};

export function noToolsSummary({
  callStatus,
  personName,
  extraction,
}: NoToolsInput): NoToolsSummary {
  /*
    First, because it explains every other emptiness on the screen at once. A
    Call that never connected has no transcript, no recording and no
    invocations, and the failure card above already carries the reason.
  */
  if (callStatus !== "completed") {
    return {
      headline: "Nothing to do — the Call did not connect",
      detail:
        "Maya never got as far as the conversation, so no Tool ran. The reason is in the card above.",
    };
  }

  if (extraction === null) {
    return {
      headline: "Maya invoked no Tools",
      detail: `The Call is still being analysed, so there is nothing yet to say about what ${personName} agreed to.`,
    };
  }

  if (extraction.status === "failed") {
    return {
      headline: "Maya invoked no Tools",
      detail:
        "And the extraction failed, so nothing has been reconstructed from the transcript either. The raw output is in the amber card below.",
    };
  }

  // Retell measures this; nothing infers it (SPEC.md §9 step 4).
  if (extraction.inVoicemail === true) {
    return {
      headline: "A machine picked up",
      detail: `Retell reported voicemail, so there was nobody to book with. ${personName}'s Appointment is untouched.`,
    };
  }

  /*
    Above `confirmed`, matching `fallbackChange` in lib/extraction/outcome.ts.
    Somebody who named a new time did not agree to the old one, whatever else
    came back in the same object — and the two files disagreeing would put
    "confirmed" on this card about an Appointment the extraction moved to Needs
    Attention.
  */
  if (extraction.newTime !== null) {
    return {
      headline: `${personName} asked for a different time`,
      detail: `Heard as "${extraction.newTime}". It is not booked — no Tool ran, and a spoken time is not a Slot. The Appointment is waiting for a human.`,
    };
  }

  if (extraction.confirmed === true) {
    return {
      headline: `${personName} confirmed, without a Tool`,
      detail:
        "Maya never invoked confirm_appointment, so this is the extraction's fallback rather than a recorded action. The Appointment was moved on the strength of it.",
    };
  }

  if (extraction.confirmed === false) {
    return {
      headline: `${personName} declined, without a Tool`,
      detail:
        "Maya never invoked cancel_appointment, so this is the extraction's fallback rather than a recorded action. The Appointment was moved on the strength of it.",
    };
  }

  return {
    headline: "Nothing was decided",
    detail: `Maya spoke to ${personName}, invoked no Tools, and the extraction found nothing to act on either. The Appointment is unchanged.`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/calls/no-tools.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/calls/no-tools.ts lib/calls/no-tools.test.ts
git commit -m "Say what happened on a Call where no Tool ran"
```

---

## Task 9: Turn a disconnect reason into a sentence

**Files:**
- Create: `lib/calls/failure-reason.ts`
- Test: `lib/calls/failure-reason.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/calls/failure-reason.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { callFailure } from "@/lib/calls/failure-reason";

/*
  The failure card, which is the only card with anything to say on a Call that
  never connected.

  `lib/webhooks/status.ts` already classifies these — this does not re-derive
  the classification, it wraps it and adds the two things a screen needs: a
  sentence in ordinary words, and whether pressing Retry could possibly work.

  Credit exhaustion is the case that earns the module. Retrying cannot succeed
  until somebody tops up the Retell balance, and a button that cannot work is
  worse than no button — it turns one failure into a person pressing it four
  times.
*/

describe("callFailure", () => {
  it("says top up the balance, and offers no Retry, on credit exhaustion", () => {
    const failure = callFailure("no_valid_payment");

    expect(failure.canRetry).toBe(false);
    expect(failure.headline).toBe("Retell has no credit left");
    expect(failure.detail).toContain("balance");
  });

  it("says wait, and offers Retry, on the concurrency limit", () => {
    const failure = callFailure("concurrency_limit_reached");

    expect(failure.canRetry).toBe(true);
    expect(failure.headline).toBe("Too many Calls at once");
  });

  it("distinguishes a voicemail from an unanswered phone", () => {
    expect(callFailure("voicemail_reached").headline).toBe("Voicemail picked up");
    expect(callFailure("dial_no_answer").headline).toBe("Nobody answered");
  });

  it("has its own sentence for a busy line and a declined Call", () => {
    expect(callFailure("dial_busy").headline).toBe("The line was busy");
    expect(callFailure("user_declined").headline).toBe("The Call was declined");
  });

  it("has its own sentence for an IVR", () => {
    expect(callFailure("ivr_reached").headline).toBe("A phone menu answered");
  });

  it("offers Retry on every no-answer reason", () => {
    const reasons = [
      "dial_no_answer",
      "dial_busy",
      "user_declined",
      "voicemail_reached",
      "ivr_reached",
    ];

    for (const reason of reasons) {
      expect(callFailure(reason).canRetry).toBe(true);
    }
  });

  it("falls back to a generic sentence, and still offers Retry, on an unknown reason", () => {
    const failure = callFailure("some_reason_retell_added_last_tuesday");

    expect(failure.canRetry).toBe(true);
    expect(failure.headline).toBe("The Call failed");
    expect(failure.detail).toContain("some_reason_retell_added_last_tuesday");
  });

  it("handles a Call that ended with no reason recorded at all", () => {
    const failure = callFailure(null);

    expect(failure.canRetry).toBe(true);
    expect(failure.headline).toBe("The Call failed");
    expect(failure.detail.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/calls/failure-reason.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/calls/failure-reason"`.

- [ ] **Step 3: Write the implementation**

Create `lib/calls/failure-reason.ts`:

```ts
import { failureKind } from "@/lib/webhooks/status";

/*
  A disconnection reason, in words a person at a front desk can act on.

  `lib/webhooks/status.ts` owns the classification — which reasons mean
  completed, no-answer or failed, and which two failures are not really about
  this Call. This module does not re-derive any of that. It wraps `failureKind`
  and adds the two things the screen needs and the webhook does not: a sentence,
  and whether Retry could possibly succeed.

  Every reason listed here comes from docs/verification.md A9, transcribed from
  Retell's own "Debug call disconnection" page.
*/

export type CallFailure = {
  headline: string;
  detail: string;
  /** Whether to render the Retry button at all. */
  canRetry: boolean;
};

const REASONS: Record<string, Omit<CallFailure, "canRetry">> = {
  dial_no_answer: {
    headline: "Nobody answered",
    detail:
      "The phone rang out. The Appointment keeps its Slot — an unanswered phone is not a cancellation (SPEC.md §14 rule 2).",
  },
  dial_busy: {
    headline: "The line was busy",
    detail: "The number was engaged. Nothing about the Appointment has changed.",
  },
  user_declined: {
    headline: "The Call was declined",
    detail:
      "Somebody rejected the Call at the handset. That is not the same as declining the Appointment, which is untouched.",
  },
  voicemail_reached: {
    headline: "Voicemail picked up",
    detail:
      "A machine answered, so there was nobody to book with. Retell reported this itself rather than it being inferred from the transcript.",
  },
  ivr_reached: {
    headline: "A phone menu answered",
    detail:
      "The number led to an automated menu rather than a person. Worth checking the number on the Appointment.",
  },
};

/**
 * What to show on a `failed` or `no_answer` Call.
 *
 * Unknown reasons get the generic sentence and are still offered a Retry, which
 * matches how `mapDisconnectionReason` fails closed: a reason Retell added after
 * this was written lands here, and refusing to let somebody try again would be
 * the worse guess.
 */
export function callFailure(reason: string | null | undefined): CallFailure {
  const kind = failureKind(reason);

  if (kind === "credit_exhausted") {
    return {
      headline: "Retell has no credit left",
      detail:
        "No Call will connect until somebody tops up the Retell balance. Retrying cannot help, so there is no Retry here.",
      canRetry: false,
    };
  }

  if (kind === "concurrency_limit") {
    return {
      headline: "Too many Calls at once",
      detail:
        "Retell refused this one because the account had hit its concurrent-Call limit. Wait a moment and try again.",
      canRetry: true,
    };
  }

  const known = reason ? REASONS[reason] : undefined;
  if (known) return { ...known, canRetry: true };

  return {
    headline: "The Call failed",
    detail: reason
      ? `Retell reported "${reason}", which Callzie does not have a specific sentence for. Trying again is reasonable.`
      : "Retell reported no reason at all, which usually means the Call never reached its network. Trying again is reasonable.",
    canRetry: true,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/calls/failure-reason.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/calls/failure-reason.ts lib/calls/failure-reason.test.ts
git commit -m "Give every disconnection reason a sentence and a verdict on Retry"
```

---

## Task 10: The one loader

**Files:**
- Create: `lib/calls/detail.ts`
- Test: `lib/calls/detail.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/calls/detail.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadCallDetail } from "@/lib/calls/detail";
import { db, schema } from "@/lib/db";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

/*
  The single read behind the Call detail screen.

  Two things are worth a database test rather than a unit test. The first is the
  tenancy guard: `callId` arrives from the URL, this app is open signup, and a
  loader that read across accounts would put one Business's transcript on
  another's screen. The second is that the joins actually line up — four tables,
  and a wrong join key returns plausible-looking nonsense rather than an error.
*/

const CLERK_ID = "user_test_call_detail";
const OTHER_CLERK_ID = "user_test_call_detail_other";
const STARTS_AT = new Date("2026-08-27T03:30:00.000Z");

let seed: ToolTestSeed;
let other: ToolTestSeed;

beforeEach(async () => {
  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: STARTS_AT,
    callStatus: "completed",
  });
  other = await seedToolTest({
    clerkId: OTHER_CLERK_ID,
    appointmentStartsAt: STARTS_AT,
    callStatus: "completed",
  });
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
  await cleanupToolTest(OTHER_CLERK_ID);
});

describe("loadCallDetail", () => {
  it("returns null for a Call belonging to another Business", async () => {
    const detail = await loadCallDetail(seed.businessId, other.callId);

    expect(detail).toBeNull();
  });

  it("returns null for an id that is not a Call at all", async () => {
    const detail = await loadCallDetail(
      seed.businessId,
      "00000000-0000-0000-0000-000000000000",
    );

    expect(detail).toBeNull();
  });

  it("carries the person and the Service off the Appointment", async () => {
    const detail = await loadCallDetail(seed.businessId, seed.callId);

    expect(detail?.personName).toBe("Priya Sharma");
    expect(detail?.serviceName).toBeTruthy();
    expect(detail?.appointmentId).toBe(seed.appointmentId);
  });

  it("returns the Tool invocations in the order they ran", async () => {
    await db.insert(schema.toolInvocations).values([
      {
        callId: seed.callId,
        toolName: "check_availability",
        arguments: {},
        result: { ok: true, slots: [] },
        succeeded: true,
        latencyMs: 100,
      },
      {
        callId: seed.callId,
        toolName: "book_slot",
        arguments: {},
        result: { ok: false, reason: "slot_taken" },
        succeeded: false,
        latencyMs: 200,
      },
    ]);

    const detail = await loadCallDetail(seed.businessId, seed.callId);

    expect(detail?.outcome.invocations).toHaveLength(2);
    expect(detail?.outcome.invocations[0].toolName).toBe("check_availability");
    expect(detail?.outcome.invocations[1].succeeded).toBe(false);
  });

  it("returns a null extraction rather than throwing when none exists yet", async () => {
    const detail = await loadCallDetail(seed.businessId, seed.callId);

    expect(detail?.extraction).toBeNull();
  });

  it("carries the extraction when one exists", async () => {
    await db.insert(schema.extractions).values({
      callId: seed.callId,
      notes: "Wants an evening slot next time.",
      summary: "Rebooked to Thursday afternoon.",
      sentiment: "positive",
      inVoicemail: false,
      status: "ok",
    });

    const detail = await loadCallDetail(seed.businessId, seed.callId);

    expect(detail?.extraction?.summary).toBe("Rebooked to Thursday afternoon.");
    expect(detail?.extraction?.sentiment).toBe("positive");
  });

  it("renders a transcript from the plain text when there are no stored turns", async () => {
    await db
      .update(schema.calls)
      .set({ transcript: "Agent: Hello.\nUser: Hi." })
      .where(eq(schema.calls.id, seed.callId));

    const detail = await loadCallDetail(seed.businessId, seed.callId);

    expect(detail?.turns).toEqual([
      { speaker: "agent", text: "Hello.", startSeconds: null },
      { speaker: "person", text: "Hi.", startSeconds: null },
    ]);
  });

  it("counts the attempts on this Appointment, so the header can say 2 of 2", async () => {
    await db.insert(schema.calls).values({
      appointmentId: seed.appointmentId,
      callType: "web",
      attempt: 2,
      status: "queued",
    });

    const detail = await loadCallDetail(seed.businessId, seed.callId);

    expect(detail?.attemptCount).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/calls/detail.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/calls/detail"`.

- [ ] **Step 3: Write the implementation**

Create `lib/calls/detail.ts`:

```ts
import { and, asc, eq } from "drizzle-orm";

import { callOutcome, type CallOutcome, type InvocationRow } from "@/lib/calls/outcome";
import { callTranscript, type TranscriptTurn } from "@/lib/calls/transcript";
import { db, schema } from "@/lib/db";
import type { CallStatus, CallType, ExtractionStatus, Sentiment } from "@/lib/db/schema";

/*
  Everything the Call detail screen reads, in one place.

  The house pattern, the same one `lib/schedule/load-day.ts` follows: one
  server-side loader that returns a plain object, and components that render it
  without thinking. The alternative — each card running its own query — costs
  five round trips and leaves every derivation untestable without mounting a
  component.

  **Scoped through `appointments` to the Business inside the WHERE clause**, the
  way `lib/business/active-calls.ts` does it. `callId` arrives from the URL and
  Callzie is open signup, so a loader that read across accounts would put one
  Business's transcript on another's screen. A miss returns null and the page
  calls `notFound()` — not a 403, which would confirm the id exists.
*/

export type CallExtraction = {
  notes: string | null;
  summary: string | null;
  sentiment: Sentiment | null;
  inVoicemail: boolean | null;
  confirmed: boolean | null;
  newTime: string | null;
  status: ExtractionStatus;
  rawLlmOutput: string | null;
};

export type CallDetail = {
  id: string;
  appointmentId: string;
  personName: string;
  phoneE164: string;
  serviceName: string;
  appointmentStartsAt: Date;
  timezone: string;
  callType: CallType;
  status: CallStatus;
  attempt: number;
  /** How many Calls this Appointment has had, for "Attempt 2 of 2". */
  attemptCount: number;
  durationSeconds: number | null;
  recordingUrl: string | null;
  disconnectReason: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  turns: TranscriptTurn[];
  /** True when a transcript exists in either column — the waiting panel's condition. */
  hasTranscript: boolean;
  outcome: CallOutcome;
  extraction: CallExtraction | null;
};

export async function loadCallDetail(
  businessId: string,
  callId: string,
): Promise<CallDetail | null> {
  const [row] = await db
    .select({
      id: schema.calls.id,
      appointmentId: schema.calls.appointmentId,
      callType: schema.calls.callType,
      status: schema.calls.status,
      attempt: schema.calls.attempt,
      durationSeconds: schema.calls.durationSeconds,
      recordingUrl: schema.calls.recordingUrl,
      transcript: schema.calls.transcript,
      transcriptTurns: schema.calls.transcriptTurns,
      disconnectReason: schema.calls.disconnectReason,
      startedAt: schema.calls.startedAt,
      endedAt: schema.calls.endedAt,
      personName: schema.appointments.name,
      phoneE164: schema.appointments.phoneE164,
      appointmentStartsAt: schema.appointments.startsAt,
      serviceName: schema.services.name,
      timezone: schema.businesses.timezone,
    })
    .from(schema.calls)
    .innerJoin(
      schema.appointments,
      eq(schema.calls.appointmentId, schema.appointments.id),
    )
    .innerJoin(schema.services, eq(schema.appointments.serviceId, schema.services.id))
    .innerJoin(
      schema.businesses,
      eq(schema.appointments.businessId, schema.businesses.id),
    )
    .where(
      and(eq(schema.calls.id, callId), eq(schema.appointments.businessId, businessId)),
    );

  // Not found, or found and belonging to somebody else. The page cannot tell
  // the two apart, which is the point.
  if (!row) return null;

  const [invocations, extraction, siblings] = await Promise.all([
    db
      .select({
        id: schema.toolInvocations.id,
        toolName: schema.toolInvocations.toolName,
        arguments: schema.toolInvocations.arguments,
        result: schema.toolInvocations.result,
        succeeded: schema.toolInvocations.succeeded,
        latencyMs: schema.toolInvocations.latencyMs,
        createdAt: schema.toolInvocations.createdAt,
      })
      .from(schema.toolInvocations)
      .where(eq(schema.toolInvocations.callId, callId))
      .orderBy(asc(schema.toolInvocations.createdAt)),
    db.query.extractions.findFirst({
      where: eq(schema.extractions.callId, callId),
    }),
    db
      .select({ id: schema.calls.id })
      .from(schema.calls)
      .where(eq(schema.calls.appointmentId, row.appointmentId)),
  ]);

  const turns = callTranscript({
    transcriptTurns: row.transcriptTurns,
    transcript: row.transcript,
  });

  return {
    id: row.id,
    appointmentId: row.appointmentId,
    personName: row.personName,
    phoneE164: row.phoneE164,
    serviceName: row.serviceName,
    appointmentStartsAt: row.appointmentStartsAt,
    timezone: row.timezone,
    callType: row.callType,
    status: row.status,
    attempt: row.attempt,
    attemptCount: siblings.length,
    durationSeconds: row.durationSeconds,
    recordingUrl: row.recordingUrl,
    disconnectReason: row.disconnectReason,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    turns,
    hasTranscript: turns.length > 0,
    /*
      `createdAt` is nullable in the schema (it has a database default, which
      Drizzle cannot promise TypeScript was applied). The Call happened, so the
      row has a time — the epoch fallback keeps the sort total without
      pretending otherwise.
    */
    outcome: callOutcome(
      invocations.map(
        (invocation): InvocationRow => ({
          ...invocation,
          createdAt: invocation.createdAt ?? new Date(0),
        }),
      ),
    ),
    extraction: extraction
      ? {
          notes: extraction.notes,
          summary: extraction.summary,
          sentiment: extraction.sentiment,
          inVoicemail: extraction.inVoicemail,
          confirmed: extraction.confirmed,
          newTime: extraction.newTime,
          status: extraction.status,
          rawLlmOutput: extraction.rawLlmOutput,
        }
      : null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/calls/detail.test.ts`
Expected: PASS, 8 tests.

If the tenancy test fails by returning a row, the `businessId` predicate is in
the wrong place — it must be in the `WHERE`, not applied after the read.

- [ ] **Step 5: Commit**

```bash
git add lib/calls/detail.ts lib/calls/detail.test.ts
git commit -m "Read the whole proof screen in one scoped pass"
```

---

## Task 11: Lift the callout out of Settings

**Files:**
- Create: `components/ui/callout.tsx`
- Modify: `components/settings/section.tsx`

- [ ] **Step 1: Create the shared component**

Create `components/ui/callout.tsx`, moving the body of `SettingsCallout` across
unchanged:

```tsx
import type * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A persistent, inline message — never a toast.
 *
 * SPEC.md §11.4 reserves toasts for transient results and requires "inline
 * persistent UI for anything requiring action". Everything this renders is the
 * second kind: the Appointments a narrowed opening window stranded, a failed
 * extraction, the reason a Call did not connect. Each names something a person
 * has to deal with, so it stays on screen until the state that produced it
 * changes.
 *
 * Lifted out of components/settings/section.tsx when the Call detail screen
 * needed the same amber for a failed extraction and a failed Call. Two screens
 * deriving this independently is how the same class of warning ends up two
 * different colours.
 *
 * `tone` maps onto SPEC.md §11.2's status colours and introduces none: `warning`
 * is the needs-attention orange, the palette's designated "a human must look at
 * this" signal.
 */
export function Callout({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: "info" | "warning" | "success"
  title?: React.ReactNode
  children?: React.ReactNode
  className?: string
}) {
  return (
    <div
      /*
        `role="status"` rather than `role="alert"`. These appear as the result of
        something the person just did, or as part of a page they navigated to,
        and an assertive live region would interrupt a screen reader mid-sentence
        to announce something they asked for. Nothing here is an emergency.
      */
      role="status"
      className={cn(
        "rounded-card border p-4 text-table",
        tone === "warning" && "border-attention/40 bg-attention/10 text-text",
        tone === "success" && "border-confirmed/40 bg-confirmed/10 text-text",
        tone === "info" && "border-line bg-bg text-text-muted",
        className
      )}
    >
      {title ? (
        <p
          className={cn(
            "font-medium",
            tone === "warning" && "text-attention",
            tone === "success" && "text-confirmed",
            tone === "info" && "text-text"
          )}
        >
          {title}
        </p>
      ) : null}
      {children ? (
        <div className={cn(title && "mt-1", "text-text-muted")}>{children}</div>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 2: Re-export from Settings**

In `components/settings/section.tsx`, delete the whole `SettingsCallout`
function and its doc comment, and replace them with:

```tsx
/**
 * Settings' name for the shared callout.
 *
 * The implementation moved to components/ui/callout.tsx when the Call detail
 * screen needed the same amber. Kept as an alias so the six Settings sections
 * that import it did not all have to change in a UI ticket.
 */
export { Callout as SettingsCallout } from "@/components/ui/callout"
```

Keep the `cn` import only if `SettingsSection` still uses it — if TypeScript now
reports it unused, remove it.

- [ ] **Step 3: Verify Settings still compiles and behaves**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm test`
Expected: PASS, unchanged from before this task.

- [ ] **Step 4: Commit**

```bash
git add components/ui/callout.tsx components/settings/section.tsx
git commit -m "Move the amber callout somewhere two screens can reach it"
```

---

## Task 12: The status pill for a Call

**Files:**
- Create: `lib/calls/status-style.ts`
- Create: `components/calls/call-status-pill.tsx`
- Test: `lib/calls/status-style.test.ts`

The existing `StatusPill` renders an `AppointmentStatus`. A Call has its own six
statuses and they are not the same words.

- [ ] **Step 1: Write the failing test**

Create `lib/calls/status-style.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { CALL_STATUS_STYLES } from "@/lib/calls/status-style";
import { CALL_STATUSES } from "@/lib/db/schema";

/*
  Six Call statuses, six entries. The test exists because the schema's union is
  the real contract (see the comment at the top of lib/db/schema.ts) and a
  status added there without a style here would render an undefined class — a
  pill with no dot and no word.
*/

describe("CALL_STATUS_STYLES", () => {
  it("covers every Call status the schema declares", () => {
    for (const status of CALL_STATUSES) {
      expect(CALL_STATUS_STYLES[status]).toBeDefined();
      expect(CALL_STATUS_STYLES[status].label.length).toBeGreaterThan(0);
      expect(CALL_STATUS_STYLES[status].background).toMatch(/^bg-/);
    }
  });

  it("gives in-progress the accent, per SPEC.md §11.2", () => {
    expect(CALL_STATUS_STYLES.in_progress.background).toBe("bg-accent");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/calls/status-style.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/calls/status-style"`.

- [ ] **Step 3: Write the implementation**

Create `lib/calls/status-style.ts`:

```ts
import type { CallStatus } from "@/lib/db/schema";
import type { StatusStyle } from "@/lib/appointments/status-style";

/**
 * Which colour and which word each Call status gets.
 *
 * The Appointment equivalent lives in lib/appointments/status-style.ts, and the
 * two are deliberately separate: a Call's `completed` and an Appointment's
 * `confirmed` are different facts, and one table of seven-plus-six entries
 * would invite reading the wrong half.
 *
 * Every colour is a token already declared in app/globals.css — the
 * `--color-*: initial` reset there means an off-token colour would not compile.
 * The values are literal class strings because Tailwind scans source text, and
 * a class assembled at runtime is a class that never gets generated.
 *
 * `completed` is the confirmed green: the conversation happened. What was
 * decided in it is the Appointment's status, not this one.
 */
export const CALL_STATUS_STYLES: Record<CallStatus, StatusStyle> = {
  queued: { background: "bg-text-muted", label: "Queued" },
  ringing: { background: "bg-accent", label: "Ringing" },
  // §11.2: "in-progress uses accent".
  in_progress: { background: "bg-accent", label: "In progress" },
  completed: { background: "bg-confirmed", label: "Completed" },
  no_answer: { background: "bg-unreachable", label: "No answer" },
  failed: { background: "bg-declined", label: "Failed" },
};
```

Create `components/calls/call-status-pill.tsx`:

```tsx
import { CALL_STATUS_STYLES } from "@/lib/calls/status-style"
import type { CallStatus } from "@/lib/db/schema"

/**
 * A Call's status as a coloured dot plus a label.
 *
 * A dot plus a word, never colour alone — about one in twelve men cannot
 * distinguish the green from the amber, and the label is what they read. Same
 * markup as components/overview/status-pill.tsx, a different table of words.
 */
export function CallStatusPill({ status }: { status: CallStatus }) {
  const style = CALL_STATUS_STYLES[status]

  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-line px-2 py-1 text-table text-text">
      <span className={`size-2 rounded-full ${style.background}`} aria-hidden />
      {style.label}
    </span>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/calls/status-style.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/calls/status-style.ts lib/calls/status-style.test.ts components/calls/call-status-pill.tsx
git commit -m "Give a Call its own six status words"
```

---

## Task 13: The player and the transcript

**Files:**
- Create: `components/calls/detail/recording-player.tsx`
- Create: `components/calls/detail/transcript-panel.tsx`
- Create: `components/calls/detail/waiting-panel.tsx`
- Test: `components/calls/detail/transcript-panel.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `components/calls/detail/transcript-panel.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { RecordingPlayer } from "@/components/calls/detail/recording-player"
import { TranscriptPanel } from "@/components/calls/detail/transcript-panel"
import type { TranscriptTurn } from "@/lib/calls/transcript"

/*
  What the left column actually puts on the page.

  `lib/calls/transcript.test.ts` pins the parsing; this pins the markup, because
  two of #16's acceptance criteria are about what renders — "the transcript
  renders as a readable two-sided conversation, with mono timestamps", and "the
  screen still works when the recording url has not arrived yet".

  `renderToStaticMarkup` rather than a testing library: these are synchronous
  Server Components with no state and no effects, so a string of HTML is the
  whole output. The one client component here, RecordingPlayer, renders its
  server-side markup the same way.
*/

const TURNS: TranscriptTurn[] = [
  { speaker: "agent", text: "Hi Priya, this is Maya.", startSeconds: 0.4 },
  { speaker: "person", text: "Hello.", startSeconds: 12 },
]

describe("TranscriptPanel", () => {
  it("renders both sides of the conversation", () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel turns={TURNS} personName="Priya" />
    )

    expect(html).toContain("Hi Priya, this is Maya.")
    expect(html).toContain("Hello.")
  })

  it("names each speaker rather than relying on which side it sits on", () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel turns={TURNS} personName="Priya" />
    )

    expect(html).toContain("Maya")
    expect(html).toContain("Priya")
  })

  it("puts the person's turns on the other side", () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel turns={TURNS} personName="Priya" />
    )

    expect(html).toContain("justify-end")
  })

  it("renders timestamps in mono", () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel turns={TURNS} personName="Priya" />
    )

    expect(html).toContain("00:00")
    expect(html).toContain("00:12")
    expect(html).toContain("font-mono")
  })

  it("omits the stamp entirely on an unstamped turn rather than showing a placeholder", () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel
        turns={[{ speaker: "agent", text: "Hello.", startSeconds: null }]}
        personName="Priya"
      />
    )

    expect(html).not.toContain("—")
    expect(html).toContain("Hello.")
  })

  it("renders a waiting panel, not nothing, when there is no transcript yet", () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel turns={[]} personName="Priya" />
    )

    expect(html).toContain("Transcript not ready yet")
  })
})

describe("RecordingPlayer", () => {
  it("renders an audio element when the url has arrived", () => {
    const html = renderToStaticMarkup(
      <RecordingPlayer recordingUrl="https://example.com/a.wav" durationSeconds={95} />
    )

    expect(html).toContain("<audio")
    expect(html).toContain("https://example.com/a.wav")
  })

  it("shows the total duration in mono", () => {
    const html = renderToStaticMarkup(
      <RecordingPlayer recordingUrl="https://example.com/a.wav" durationSeconds={95} />
    )

    expect(html).toContain("01:35")
    expect(html).toContain("font-mono")
  })

  it("renders a waiting panel and no audio element when the url has not arrived", () => {
    const html = renderToStaticMarkup(
      <RecordingPlayer recordingUrl={null} durationSeconds={95} />
    )

    expect(html).not.toContain("<audio")
    expect(html).toContain("Recording not ready yet")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run components/calls/detail/transcript-panel.test.tsx`
Expected: FAIL — the three imports do not resolve.

- [ ] **Step 3: Write the shared waiting panel**

Create `components/calls/detail/waiting-panel.tsx`:

```tsx
import { Loader2 } from "lucide-react"

/**
 * A block whose data has not arrived yet.
 *
 * Retell delivers the transcript on `call_ended` and the recording on
 * `call_analyzed`, minutes apart (docs/verification.md A9). Hiding the block
 * until its data lands would change the shape of the screen under the reader
 * and give them no way to tell whether anything is still coming — so every
 * block says so itself instead.
 *
 * Quiet on purpose. This is not a failure, and `components/ui/callout.tsx`'s
 * amber is reserved for things a person has to act on. The page is already
 * re-reading; there is nothing for anyone to do here but wait.
 */
export function WaitingPanel({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-3 rounded-card border border-dashed border-line bg-bg p-6 text-table text-text-muted">
      <Loader2 className="mt-px size-4 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
      <div>
        <p className="font-medium text-text">{title}</p>
        <p className="mt-1">{children}</p>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Write the player**

Create `components/calls/detail/recording-player.tsx`:

```tsx
"use client"

import * as React from "react"

import { WaitingPanel } from "@/components/calls/detail/waiting-panel"
import { formatDuration } from "@/lib/calls/duration"

/**
 * The Call's recording, with its position and length in mono.
 *
 * A client component for one reason: the position readout. `<audio controls>`
 * has its own, but it is the browser's chrome in the browser's colours, and
 * SPEC.md §11.3 asks for a themed player with the duration in mono. So the
 * element carries `controls` for the transport — which is what gives us keyboard
 * access and a scrubber for free, and is far better than anything hand-rolled —
 * and the readout beside it is ours.
 *
 * `durationSeconds` is what the webhook recorded, and it is the value shown
 * until the file's own metadata loads. The two can disagree by a second; the
 * recorded one is the Call's duration and the one that matches the header.
 */
export function RecordingPlayer({
  recordingUrl,
  durationSeconds,
}: {
  recordingUrl: string | null
  durationSeconds: number | null
}) {
  const [position, setPosition] = React.useState(0)

  if (!recordingUrl) {
    return (
      <WaitingPanel title="Recording not ready yet">
        Retell publishes the audio after it has finished analysing the Call. This
        panel will become a player on its own.
      </WaitingPanel>
    )
  }

  return (
    <div className="rounded-card border border-line bg-surface p-4">
      <div className="flex items-center gap-4">
        <audio
          className="min-w-0 flex-1"
          controls
          preload="metadata"
          src={recordingUrl}
          onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        >
          {/* Read by anyone whose browser will not play the file at all. */}
          <a href={recordingUrl}>Download the recording</a>
        </audio>
        <p className="shrink-0 font-mono text-table text-text-muted tabular-nums">
          {formatDuration(position)} / {formatDuration(durationSeconds)}
        </p>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Write the transcript**

Create `components/calls/detail/transcript-panel.tsx`:

```tsx
import { WaitingPanel } from "@/components/calls/detail/waiting-panel"
import { formatDuration } from "@/lib/calls/duration"
import type { TranscriptTurn } from "@/lib/calls/transcript"

/**
 * The Call as a two-sided conversation (SPEC.md §11.3).
 *
 * Maya's turns sit left behind a teal avatar dot; the other person's sit right.
 * Each turn is named as well as placed — which side a bubble sits on is not
 * information a screen reader conveys, and the name is what makes the transcript
 * readable when it is read aloud rather than looked at.
 *
 * A turn with no timestamp renders no timestamp, rather than an em-dash. The
 * stamps come from Retell's `transcript_object`, which arrives on
 * `call_analyzed` — a Call whose text transcript landed on `call_ended` has
 * none yet, and a column of placeholders would suggest the times are missing
 * rather than merely late.
 */
export function TranscriptPanel({
  turns,
  personName,
}: {
  turns: TranscriptTurn[]
  personName: string
}) {
  if (turns.length === 0) {
    return (
      <WaitingPanel title="Transcript not ready yet">
        Retell sends the transcript once the Call has ended. This panel will fill
        in on its own.
      </WaitingPanel>
    )
  }

  return (
    <ol className="flex flex-col gap-4">
      {turns.map((turn, index) => (
        <li
          // Index is a legitimate key here: a transcript is append-only and
          // never reordered, so a turn's position is stable for its lifetime.
          key={index}
          className={
            turn.speaker === "agent"
              ? "flex justify-start"
              : "flex justify-end"
          }
        >
          <div className="flex max-w-[85%] flex-col gap-1">
            <div
              className={
                turn.speaker === "agent"
                  ? "flex items-center gap-2"
                  : "flex flex-row-reverse items-center gap-2"
              }
            >
              {turn.speaker === "agent" ? (
                <span className="size-2 rounded-full bg-accent" aria-hidden />
              ) : null}
              <span className="text-table font-medium text-text">
                {turn.speaker === "agent" ? "Maya" : personName}
              </span>
              {turn.startSeconds !== null ? (
                <span className="font-mono text-table text-text-muted tabular-nums">
                  {formatDuration(turn.startSeconds)}
                </span>
              ) : null}
            </div>
            <p
              className={
                turn.speaker === "agent"
                  ? "rounded-card border border-line bg-surface px-4 py-3 text-body text-text"
                  : "rounded-card border border-line bg-bg px-4 py-3 text-right text-body text-text"
              }
            >
              {turn.text}
            </p>
          </div>
        </li>
      ))}
    </ol>
  )
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run components/calls/detail/transcript-panel.test.tsx`
Expected: PASS, 9 tests.

- [ ] **Step 7: Commit**

```bash
git add components/calls/detail/ components/calls/detail/transcript-panel.test.tsx
git commit -m "Render the recording and the conversation, including before they arrive"
```

---

## Task 14: The Outcome card

**Files:**
- Create: `components/calls/detail/outcome-card.tsx`
- Create: `components/calls/detail/json-block.tsx`
- Test: `components/calls/detail/outcome-card.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `components/calls/detail/outcome-card.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { OutcomeCard } from "@/components/calls/detail/outcome-card"
import { callOutcome, type InvocationRow } from "@/lib/calls/outcome"

/*
  The card the whole screen exists for.

  Two acceptance criteria land here: "the Outcome card shows every Tool
  invocation in order, including failed ones", and "a Call where the Agent
  invoked nothing renders sensibly rather than blank".
*/

const AT = (seconds: number) => new Date(2026, 7, 21, 9, 0, seconds)

const CHECK: InvocationRow = {
  id: "check",
  toolName: "check_availability",
  arguments: {},
  result: {
    ok: true,
    slots: [
      { slot_start: "2026-08-27T10:30:00.000Z", time: "Thursday at four in the afternoon" },
    ],
  },
  succeeded: true,
  latencyMs: 120,
  createdAt: AT(1),
}

const FAILED_BOOK: InvocationRow = {
  id: "book",
  toolName: "book_slot",
  arguments: { slot_start: "2026-08-27T10:30:00.000Z" },
  result: { ok: false, reason: "slot_taken" },
  succeeded: false,
  latencyMs: 340,
  createdAt: AT(2),
}

const NO_TOOLS = {
  headline: "Nothing was decided",
  detail: "Maya spoke to Priya, invoked no Tools.",
}

describe("OutcomeCard", () => {
  it("shows a failed invocation, marked as failed", () => {
    const html = renderToStaticMarkup(
      <OutcomeCard outcome={callOutcome([CHECK, FAILED_BOOK])} noTools={NO_TOOLS} />
    )

    expect(html).toContain("book_slot")
    expect(html).toContain("Failed")
    expect(html).toContain("slot_taken")
  })

  it("shows both invocations, in the order they ran", () => {
    const html = renderToStaticMarkup(
      <OutcomeCard outcome={callOutcome([CHECK, FAILED_BOOK])} noTools={NO_TOOLS} />
    )

    expect(html.indexOf("check_availability")).toBeLessThan(html.indexOf("book_slot"))
  })

  it("renders each invocation's latency in mono", () => {
    const html = renderToStaticMarkup(
      <OutcomeCard outcome={callOutcome([CHECK, FAILED_BOOK])} noTools={NO_TOOLS} />
    )

    expect(html).toContain("340")
    expect(html).toContain("font-mono")
  })

  it("lists the Slots the Call offered, in the words Maya said", () => {
    const html = renderToStaticMarkup(
      <OutcomeCard outcome={callOutcome([CHECK])} noTools={NO_TOOLS} />
    )

    expect(html).toContain("Thursday at four in the afternoon")
  })

  it("says nothing was booked when no booking committed", () => {
    const html = renderToStaticMarkup(
      <OutcomeCard outcome={callOutcome([CHECK, FAILED_BOOK])} noTools={NO_TOOLS} />
    )

    expect(html).toContain("Nothing booked")
  })

  it("names the booked time when one committed", () => {
    const booked: InvocationRow = {
      ...FAILED_BOOK,
      succeeded: true,
      result: { ok: true, booked_time: "Thursday at four in the afternoon" },
    }

    const html = renderToStaticMarkup(
      <OutcomeCard outcome={callOutcome([CHECK, booked])} noTools={NO_TOOLS} />
    )

    expect(html).toContain("Booked")
  })

  it("renders the no-Tools sentence, not a blank card, when nothing ran", () => {
    const html = renderToStaticMarkup(
      <OutcomeCard outcome={callOutcome([])} noTools={NO_TOOLS} />
    )

    expect(html).toContain("Nothing was decided")
    expect(html).toContain("Maya spoke to Priya, invoked no Tools.")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run components/calls/detail/outcome-card.test.tsx`
Expected: FAIL — `Failed to resolve import "@/components/calls/detail/outcome-card"`.

- [ ] **Step 3: Write the JSON block**

Create `components/calls/detail/json-block.tsx`:

```tsx
/**
 * A jsonb value, printed for a human to read.
 *
 * Used for a Tool's arguments and result, and for the Extraction card's raw
 * block. `JSON.stringify` with two spaces rather than a bespoke renderer: these
 * are debugging surfaces, and the shape of the object is part of what somebody
 * reading them needs to see.
 *
 * `overflow-x-auto` because a `slot_start` is a 24-character ISO string and the
 * right column is narrow. The page body must never scroll sideways.
 */
export function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="overflow-x-auto rounded-control border border-line bg-bg p-3 font-mono text-table text-text-muted">
      {JSON.stringify(value ?? null, null, 2)}
    </pre>
  )
}
```

- [ ] **Step 4: Write the card**

Create `components/calls/detail/outcome-card.tsx`:

```tsx
import { Check, X } from "lucide-react"

import { JsonBlock } from "@/components/calls/detail/json-block"
import type { CallOutcome } from "@/lib/calls/outcome"
import type { NoToolsSummary } from "@/lib/calls/no-tools"

/**
 * What the Agent DID, from `tool_invocations` (SPEC.md §9 step 3).
 *
 * This is the claim the product is making, so the card is built from the rows
 * the Tool endpoints wrote during the Call and not from `extractions`, which is
 * only what was said about it afterwards.
 *
 * **Failed invocations render, in place, marked as failed.** A `book_slot` that
 * failed is the most interesting row here — it is the moment Maya named a time
 * and Callzie could not honour it — and a card that dropped it would be quietly
 * undoing the claim. SPEC.md §3 rule 7 is about exactly this failure.
 */
export function OutcomeCard({
  outcome,
  noTools,
}: {
  outcome: CallOutcome
  noTools: NoToolsSummary
}) {
  return (
    <section className="rounded-card border border-line bg-surface p-6">
      <h2 className="text-section font-medium text-text">What Maya did</h2>

      {outcome.invocations.length === 0 ? (
        <div className="mt-4">
          <p className="text-body font-medium text-text">{noTools.headline}</p>
          <p className="mt-1 max-w-prose text-table text-text-muted">
            {noTools.detail}
          </p>
        </div>
      ) : (
        <>
          <ol className="mt-5 flex flex-col gap-3">
            {outcome.invocations.map((invocation) => (
              <li
                key={invocation.id}
                className="rounded-card border border-line bg-bg p-4"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    className={
                      invocation.succeeded
                        ? "inline-flex items-center gap-1 text-table text-confirmed"
                        : "inline-flex items-center gap-1 text-table text-declined"
                    }
                  >
                    {invocation.succeeded ? (
                      <Check className="size-4" aria-hidden />
                    ) : (
                      <X className="size-4" aria-hidden />
                    )}
                    {invocation.succeeded ? "Succeeded" : "Failed"}
                  </span>
                  <span className="font-mono text-table text-text">
                    {invocation.toolName}
                  </span>
                  {invocation.latencyMs !== null ? (
                    /* A slow Tool is dead air on a live call — issue #10. */
                    <span className="ml-auto font-mono text-table text-text-muted tabular-nums">
                      {invocation.latencyMs} ms
                    </span>
                  ) : null}
                </div>

                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    <p className="text-table text-text-muted">Arguments</p>
                    <div className="mt-1">
                      <JsonBlock value={invocation.arguments} />
                    </div>
                  </div>
                  <div>
                    <p className="text-table text-text-muted">Result</p>
                    <div className="mt-1">
                      <JsonBlock value={invocation.result} />
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ol>

          <dl className="mt-5 flex flex-col gap-3 border-t border-line pt-5">
            <div>
              <dt className="text-table text-text-muted">Slots offered</dt>
              <dd className="mt-1 text-body text-text">
                {outcome.offeredSlots.length === 0 ? (
                  "None — Maya never named a time."
                ) : (
                  <ul className="flex flex-col gap-1">
                    {outcome.offeredSlots.map((slot) => (
                      <li key={slot.slot_start}>
                        {slot.time}{" "}
                        <span className="font-mono text-table text-text-muted">
                          {slot.slot_start}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-table text-text-muted">Outcome</dt>
              <dd className="mt-1 text-body text-text">
                {outcome.bookedTime
                  ? `Booked — ${outcome.bookedTime}`
                  : "Nothing booked on this Call."}
              </dd>
            </div>
          </dl>
        </>
      )}
    </section>
  )
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run components/calls/detail/outcome-card.test.tsx`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add components/calls/detail/outcome-card.tsx components/calls/detail/json-block.tsx components/calls/detail/outcome-card.test.tsx
git commit -m "Show every Tool invocation, in order, failures included"
```

---

## Task 15: The Extraction card, and its amber failure

**Files:**
- Create: `components/calls/detail/extraction-card.tsx`
- Test: `components/calls/detail/extraction-card.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `components/calls/detail/extraction-card.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { ExtractionCard } from "@/components/calls/detail/extraction-card"
import type { CallExtraction } from "@/lib/calls/detail"

/*
  "A failed extraction renders as a designed amber card with the raw output" —
  #16's fourth acceptance criterion, and SPEC.md §11.3's "never an unstyled
  error".

  The sentence that has to survive on that card is the one about the Tools: a
  failed extraction changes nothing about what the Agent recorded during the
  Call (SPEC.md §9 step 3). Somebody reading an amber card needs to know the
  booking is still good.
*/

const OK: CallExtraction = {
  notes: "Wants an evening slot next time.",
  summary: "Rebooked to Thursday afternoon.",
  sentiment: "positive",
  inVoicemail: false,
  confirmed: null,
  newTime: null,
  status: "ok",
  rawLlmOutput: null,
}

describe("ExtractionCard", () => {
  it("shows notes, summary and sentiment", () => {
    const html = renderToStaticMarkup(<ExtractionCard extraction={OK} />)

    expect(html).toContain("Wants an evening slot next time.")
    expect(html).toContain("Rebooked to Thursday afternoon.")
    expect(html).toContain("Positive")
  })

  it("puts the raw JSON in a collapsed block", () => {
    const html = renderToStaticMarkup(<ExtractionCard extraction={OK} />)

    expect(html).toContain("<details")
    expect(html).not.toContain("<details open")
    expect(html).toContain("Raw JSON")
  })

  it("renders amber, with the raw output, when the extraction failed", () => {
    const html = renderToStaticMarkup(
      <ExtractionCard
        extraction={{
          ...OK,
          status: "failed",
          notes: null,
          summary: null,
          sentiment: null,
          rawLlmOutput: "Sure! Here is the JSON you asked for: {oops",
        }}
      />
    )

    expect(html).toContain("border-attention/40")
    expect(html).toContain("Extraction failed")
    expect(html).toContain("Sure! Here is the JSON you asked for: {oops")
  })

  it("says the Call's recorded outcome is unaffected by a failed extraction", () => {
    const html = renderToStaticMarkup(
      <ExtractionCard
        extraction={{ ...OK, status: "failed", rawLlmOutput: "{oops" }}
      />
    )

    expect(html).toContain("unaffected")
  })

  it("handles a failed extraction that stored no raw output at all", () => {
    const html = renderToStaticMarkup(
      <ExtractionCard extraction={{ ...OK, status: "failed", rawLlmOutput: null }} />
    )

    expect(html).toContain("Extraction failed")
    expect(html).toContain("nothing was stored")
  })

  it("renders a waiting panel when the extraction has not run yet", () => {
    const html = renderToStaticMarkup(<ExtractionCard extraction={null} />)

    expect(html).toContain("Extraction not ready yet")
  })

  it("says so plainly when a field came back empty", () => {
    const html = renderToStaticMarkup(
      <ExtractionCard extraction={{ ...OK, notes: null }} />
    )

    expect(html).toContain("No notes")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run components/calls/detail/extraction-card.test.tsx`
Expected: FAIL — `Failed to resolve import "@/components/calls/detail/extraction-card"`.

- [ ] **Step 3: Write the implementation**

Create `components/calls/detail/extraction-card.tsx`:

```tsx
import { JsonBlock } from "@/components/calls/detail/json-block"
import { WaitingPanel } from "@/components/calls/detail/waiting-panel"
import { Callout } from "@/components/ui/callout"
import type { CallExtraction } from "@/lib/calls/detail"
import type { Sentiment } from "@/lib/db/schema"

/**
 * What was SAID — notes, summary and sentiment (SPEC.md §9).
 *
 * Below the Outcome card, and deliberately: this is the LLM's reading of the
 * transcript, and the card above is the record of what actually happened. When
 * the two disagree, the one above wins.
 *
 * A failed extraction is a designed amber card, not an error. SPEC.md §11.3 says
 * so in as many words, and SPEC.md §3 rule 5 is why the raw output is kept at
 * all: a failed parse that vanishes is a failed parse nobody can fix. The card
 * also states the thing a person reading amber most needs to know — the Tools
 * already wrote the outcome, and this failure did not touch it.
 */

const SENTIMENT_LABELS: Record<Sentiment, string> = {
  positive: "Positive",
  neutral: "Neutral",
  negative: "Negative",
}

export function ExtractionCard({
  extraction,
}: {
  extraction: CallExtraction | null
}) {
  if (!extraction) {
    return (
      <WaitingPanel title="Extraction not ready yet">
        It runs once Retell has finished analysing the Call. Nothing on the card
        above depends on it.
      </WaitingPanel>
    )
  }

  if (extraction.status === "failed") {
    return (
      <Callout tone="warning" title="Extraction failed">
        <p>
          The model&apos;s answer could not be read as the shape Callzie asked
          for, twice. What the Agent recorded during the Call is unaffected —
          the card above is the outcome, and nothing here can change it.
        </p>
        <details className="mt-3">
          <summary className="cursor-pointer text-text">Raw output</summary>
          <div className="mt-2">
            {extraction.rawLlmOutput ? (
              <pre className="overflow-x-auto rounded-control border border-line bg-bg p-3 font-mono text-table text-text-muted">
                {extraction.rawLlmOutput}
              </pre>
            ) : (
              <p>The Call failed before the model answered, so nothing was stored.</p>
            )}
          </div>
        </details>
      </Callout>
    )
  }

  return (
    <section className="rounded-card border border-line bg-surface p-6">
      <h2 className="text-section font-medium text-text">What was said</h2>

      <dl className="mt-5 flex flex-col gap-4">
        <div>
          <dt className="text-table text-text-muted">Summary</dt>
          <dd className="mt-1 max-w-prose text-body text-text">
            {extraction.summary ?? "No summary."}
          </dd>
        </div>
        <div>
          <dt className="text-table text-text-muted">Notes</dt>
          <dd className="mt-1 max-w-prose text-body text-text">
            {extraction.notes ?? "No notes."}
          </dd>
        </div>
        <div>
          <dt className="text-table text-text-muted">Sentiment</dt>
          <dd className="mt-1 text-body text-text">
            {extraction.sentiment
              ? SENTIMENT_LABELS[extraction.sentiment]
              : "Not reported."}
          </dd>
        </div>
      </dl>

      {/* Collapsed, per SPEC.md §11.3. It is here to be checked, not read. */}
      <details className="mt-5 border-t border-line pt-5">
        <summary className="cursor-pointer text-table text-text-muted">
          Raw JSON
        </summary>
        <div className="mt-2">
          <JsonBlock value={extraction} />
        </div>
      </details>
    </section>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run components/calls/detail/extraction-card.test.tsx`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add components/calls/detail/extraction-card.tsx components/calls/detail/extraction-card.test.tsx
git commit -m "Design the failed extraction instead of dumping it"
```

---

## Task 16: The failure card and Retry

**Files:**
- Create: `components/calls/detail/retry-call-button.tsx`
- Create: `components/calls/detail/failure-card.tsx`
- Test: `components/calls/detail/failure-card.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `components/calls/detail/failure-card.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { FailureCard } from "@/components/calls/detail/failure-card"

/*
  "Failed and no-answer Calls show the reason and offer Retry" — #16's fifth
  acceptance criterion, minus the one case where Retry cannot possibly work.

  The Retry button is a client component that reads the live-call context, and a
  context read outside a provider throws. `FailureCard` therefore takes the
  button as a prop rather than importing it, which is also what lets this test
  render the card as a plain string.
*/

describe("FailureCard", () => {
  it("gives an unanswered Call its reason", () => {
    const html = renderToStaticMarkup(
      <FailureCard disconnectReason="dial_no_answer" retry={<button>Retry call</button>} />
    )

    expect(html).toContain("Nobody answered")
    expect(html).toContain("Retry call")
  })

  it("renders amber, because this is something a person must act on", () => {
    const html = renderToStaticMarkup(
      <FailureCard disconnectReason="dial_no_answer" retry={<button>Retry call</button>} />
    )

    expect(html).toContain("border-attention/40")
  })

  it("distinguishes voicemail from an unanswered phone", () => {
    const html = renderToStaticMarkup(
      <FailureCard disconnectReason="voicemail_reached" retry={<button>Retry call</button>} />
    )

    expect(html).toContain("Voicemail picked up")
  })

  it("does not render Retry when the Retell balance is gone", () => {
    const html = renderToStaticMarkup(
      <FailureCard disconnectReason="no_valid_payment" retry={<button>Retry call</button>} />
    )

    expect(html).toContain("Retell has no credit left")
    expect(html).not.toContain("Retry call")
  })

  it("still shows something for a Call that recorded no reason", () => {
    const html = renderToStaticMarkup(
      <FailureCard disconnectReason={null} retry={<button>Retry call</button>} />
    )

    expect(html).toContain("The Call failed")
    expect(html).toContain("Retry call")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run components/calls/detail/failure-card.test.tsx`
Expected: FAIL — `Failed to resolve import "@/components/calls/detail/failure-card"`.

- [ ] **Step 3: Write the card**

Create `components/calls/detail/failure-card.tsx`:

```tsx
import type * as React from "react"

import { Callout } from "@/components/ui/callout"
import { callFailure } from "@/lib/calls/failure-reason"

/**
 * Why a Call did not produce a conversation, and what to do about it.
 *
 * Rendered above the Outcome and Extraction cards, because on a Call that never
 * connected it is the only card with anything to say — everything below it is
 * empty for the reason this one is explaining.
 *
 * Amber rather than red. SPEC.md §11.4 wants inline persistent UI for anything
 * requiring action, and the needs-attention orange is the palette's signal for
 * exactly that. Red is the `declined` token, which means the person said no —
 * a different fact entirely.
 *
 * `retry` arrives as a prop rather than being imported. The button is a client
 * component that reads the live-call context, and taking it as a prop keeps this
 * card a plain Server Component that renders to a string in a test.
 */
export function FailureCard({
  disconnectReason,
  retry,
}: {
  disconnectReason: string | null
  retry: React.ReactNode
}) {
  const failure = callFailure(disconnectReason)

  return (
    <Callout tone="warning" title={failure.headline}>
      <p className="max-w-prose">{failure.detail}</p>
      {failure.canRetry ? <div className="mt-4">{retry}</div> : null}
    </Callout>
  )
}
```

- [ ] **Step 4: Write the button**

Create `components/calls/detail/retry-call-button.tsx`:

```tsx
"use client"

import { RotateCcw } from "lucide-react"

import { useLiveCall } from "@/components/calls/live-call-provider"
import { Button } from "@/components/ui/button"

/**
 * Try this Appointment again, from the Call that failed.
 *
 * It starts a Web Call through the same provider the Quick Call card and every
 * table row use — there is one microphone, one `RetellWebClient` and one
 * 30-second deadline in this app, and a second implementation here would drift
 * from all three.
 *
 * `startWebCall` writes a NEW `calls` row with `attempt: existing + 1`
 * (lib/calls/start-web-call.ts). So a retry does not revive this Call; it
 * creates the next one, and this page stays readable as the record of the
 * attempt that failed. The header links between them.
 *
 * Disabled while any Call is in flight, with a `title` that says why — the same
 * rule, and the same reasoning, as components/calls/call-now-button.tsx. A
 * disabled control that does not explain itself reads as a broken one.
 *
 * Quota is deliberately not checked. The server owns that bound, and a button
 * that hid itself would be guessing at it; pressing it and being refused in the
 * live-call bar is the honest version.
 */
export function RetryCallButton({
  appointmentId,
  personName,
}: {
  appointmentId: string
  personName: string
}) {
  const { busy, start } = useLiveCall()

  return (
    <Button
      size="sm"
      disabled={busy}
      title={busy ? "Finish the call in progress first" : undefined}
      onClick={() => start({ appointmentId, name: personName })}
    >
      <RotateCcw aria-hidden />
      Retry call
      <span className="sr-only"> — {personName}</span>
    </Button>
  )
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run components/calls/detail/failure-card.test.tsx`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add components/calls/detail/failure-card.tsx components/calls/detail/retry-call-button.tsx components/calls/detail/failure-card.test.tsx
git commit -m "Give a Call that did not connect a reason and a way forward"
```

---

## Task 17: Re-read the page while data is still landing

**Files:**
- Create: `components/calls/detail/call-detail-poller.tsx`
- Create: `lib/calls/outstanding.ts`
- Test: `lib/calls/outstanding.test.ts`

The decision of *whether* to poll is a pure function and gets a test. The
`setInterval` around it does not.

- [ ] **Step 1: Write the failing test**

Create `lib/calls/outstanding.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { hasOutstandingData } from "@/lib/calls/outstanding";

/*
  Whether the Call detail screen still has anything to wait for.

  Two reasons this is a function rather than an inline condition. It decides
  whether a timer runs at all, so getting it wrong either leaves a page
  refreshing forever or leaves a demo staring at "not ready yet" — and it is the
  one part of the polling story worth a test, because a `setInterval` around
  `router.refresh()` is not.

  A Call that never connected has nothing outstanding. It will never get a
  transcript or a recording, so waiting for them would be waiting forever.
*/

const SETTLED = {
  status: "completed" as const,
  hasTranscript: true,
  hasRecording: true,
  hasExtraction: true,
};

describe("hasOutstandingData", () => {
  it("waits while the Call is queued, ringing or in progress", () => {
    for (const status of ["queued", "ringing", "in_progress"] as const) {
      expect(hasOutstandingData({ ...SETTLED, status })).toBe(true);
    }
  });

  it("waits for a transcript that has not arrived", () => {
    expect(hasOutstandingData({ ...SETTLED, hasTranscript: false })).toBe(true);
  });

  it("waits for a recording that has not arrived", () => {
    expect(hasOutstandingData({ ...SETTLED, hasRecording: false })).toBe(true);
  });

  it("waits for an extraction that has not run", () => {
    expect(hasOutstandingData({ ...SETTLED, hasExtraction: false })).toBe(true);
  });

  it("stops once everything has landed", () => {
    expect(hasOutstandingData(SETTLED)).toBe(false);
  });

  it("stops on a Call that never connected, whatever is missing", () => {
    for (const status of ["no_answer", "failed"] as const) {
      expect(
        hasOutstandingData({
          status,
          hasTranscript: false,
          hasRecording: false,
          hasExtraction: false,
        }),
      ).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/calls/outstanding.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/calls/outstanding"`.

- [ ] **Step 3: Write the implementation**

Create `lib/calls/outstanding.ts`:

```ts
import type { CallStatus } from "@/lib/db/schema";

/** Statuses where the Call has not finished happening yet. */
const UNSETTLED: readonly CallStatus[] = ["queued", "ringing", "in_progress"];

export type OutstandingInput = {
  status: CallStatus;
  hasTranscript: boolean;
  hasRecording: boolean;
  hasExtraction: boolean;
};

/**
 * Is the Call detail screen still waiting for something?
 *
 * Retell delivers the transcript on `call_ended` and the recording and the
 * analysis on `call_analyzed`, minutes apart, so a screen opened the moment a
 * Call ends fills in over several deliveries.
 *
 * A Call that never connected is settled whatever is missing. `no_answer` and
 * `failed` produce no transcript, no recording and no extraction, ever —
 * polling for them would refresh the page until the tab is closed.
 */
export function hasOutstandingData({
  status,
  hasTranscript,
  hasRecording,
  hasExtraction,
}: OutstandingInput): boolean {
  if (UNSETTLED.includes(status)) return true;
  if (status !== "completed") return false;

  return !hasTranscript || !hasRecording || !hasExtraction;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/calls/outstanding.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the poller**

Create `components/calls/detail/call-detail-poller.tsx`:

```tsx
"use client"

import { useRouter } from "next/navigation"
import * as React from "react"

/** How often the page re-reads while anything is outstanding (SPEC.md §11.3). */
const REFRESH_MS = 5_000

/**
 * Re-reads the Call detail while its data is still arriving.
 *
 * Renders nothing. `router.refresh()` re-runs the Server Component above it and
 * swaps the result in without losing client state — so the player keeps playing
 * while the transcript fills in beneath it.
 *
 * The parent decides whether to render this at all, using `hasOutstandingData`.
 * Keeping the decision out here means the interval simply does not exist on a
 * settled Call, rather than existing and returning early forever.
 */
export function CallDetailPoller() {
  const router = useRouter()

  React.useEffect(() => {
    const timer = setInterval(() => router.refresh(), REFRESH_MS)
    return () => clearInterval(timer)
  }, [router])

  return null
}
```

- [ ] **Step 6: Commit**

```bash
git add lib/calls/outstanding.ts lib/calls/outstanding.test.ts components/calls/detail/call-detail-poller.tsx
git commit -m "Re-read the screen until the data has landed, then stop"
```

---

## Task 18: Assemble the screen

**Files:**
- Create: `components/calls/detail/call-header.tsx`
- Create: `app/(app)/calls/[id]/page.tsx`

- [ ] **Step 1: Write the header**

Create `components/calls/detail/call-header.tsx`:

```tsx
import Link from "next/link"

import { CallStatusPill } from "@/components/calls/call-status-pill"
import { formatDuration } from "@/lib/calls/duration"
import type { CallDetail } from "@/lib/calls/detail"

/**
 * Who this Call was to, about what, and how it went.
 *
 * The Appointment time is formatted in the Business's IANA timezone — the
 * timezone is a property of the Business, and rendering an instant in the
 * reader's local zone would show a different time to somebody on holiday.
 * `Intl.DateTimeFormat` with `timeZone` is the whole mechanism; there is no
 * timezone library in this project (ADR-0007).
 */
export function CallHeader({ detail }: { detail: CallDetail }) {
  const when = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: detail.timezone,
  }).format(detail.appointmentStartsAt)

  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-page font-medium text-text">{detail.personName}</h1>
        <CallStatusPill status={detail.status} />
      </div>

      <dl className="flex flex-wrap items-center gap-x-6 gap-y-2 text-table text-text-muted">
        <div className="flex items-center gap-2">
          <dt>Service</dt>
          <dd className="text-text">{detail.serviceName}</dd>
        </div>
        <div className="flex items-center gap-2">
          <dt>Appointment</dt>
          <dd className="font-mono text-text tabular-nums">{when}</dd>
        </div>
        <div className="flex items-center gap-2">
          <dt>Duration</dt>
          <dd className="font-mono text-text tabular-nums">
            {formatDuration(detail.durationSeconds)}
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <dt>Attempt</dt>
          <dd className="text-text">
            {detail.attempt} of {detail.attemptCount}
          </dd>
        </div>
      </dl>

      {detail.attemptCount > 1 ? (
        <p className="text-table text-text-muted">
          <Link className="text-accent underline-offset-4 hover:underline" href="/calls">
            See the other attempts for {detail.personName}
          </Link>
        </p>
      ) : null}
    </header>
  )
}
```

- [ ] **Step 2: Write the page**

Create `app/(app)/calls/[id]/page.tsx`:

```tsx
import { notFound } from "next/navigation"

import { CallDetailPoller } from "@/components/calls/detail/call-detail-poller"
import { CallHeader } from "@/components/calls/detail/call-header"
import { ExtractionCard } from "@/components/calls/detail/extraction-card"
import { FailureCard } from "@/components/calls/detail/failure-card"
import { OutcomeCard } from "@/components/calls/detail/outcome-card"
import { RecordingPlayer } from "@/components/calls/detail/recording-player"
import { RetryCallButton } from "@/components/calls/detail/retry-call-button"
import { TranscriptPanel } from "@/components/calls/detail/transcript-panel"
import { requireBusiness } from "@/lib/business/require-business"
import { loadCallDetail } from "@/lib/calls/detail"
import { noToolsSummary } from "@/lib/calls/no-tools"
import { hasOutstandingData } from "@/lib/calls/outstanding"

/**
 * The proof screen (SPEC.md §11.3, issue #16).
 *
 * A Server Component. Everything it renders comes from one `loadCallDetail`
 * call, and the two client components below it — the player and the poller —
 * are leaves rather than wrappers, so nothing here ships to the browser that
 * does not have to.
 *
 * `notFound()` rather than a 403 on a Call this Business does not own. The id
 * arrives from the URL and Callzie is open signup, so a 403 would confirm the id
 * exists. `loadCallDetail` cannot tell "no such Call" from "somebody else's
 * Call", which is the point.
 */
export default async function CallDetailPage({ params }: PageProps<"/calls/[id]">) {
  const { business } = await requireBusiness()
  const { id } = await params

  const detail = await loadCallDetail(business.id, id)
  if (!detail) notFound()

  const connected = detail.status !== "failed" && detail.status !== "no_answer"

  const outstanding = hasOutstandingData({
    status: detail.status,
    hasTranscript: detail.hasTranscript,
    hasRecording: detail.recordingUrl !== null,
    hasExtraction: detail.extraction !== null,
  })

  return (
    <div className="flex flex-col gap-6">
      {outstanding ? <CallDetailPoller /> : null}

      <CallHeader detail={detail} />

      {/* Two columns above `lg`, stacked below — SPEC.md §11.4's 375px floor. */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-6">
          <RecordingPlayer
            recordingUrl={detail.recordingUrl}
            durationSeconds={detail.durationSeconds}
          />
          <TranscriptPanel turns={detail.turns} personName={detail.personName} />
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          {/*
            First in this column on purpose. On a Call that never connected this
            is the only card with anything to say, and the two below it are empty
            for the reason it is explaining.
          */}
          {!connected ? (
            <FailureCard
              disconnectReason={detail.disconnectReason}
              retry={
                <RetryCallButton
                  appointmentId={detail.appointmentId}
                  personName={detail.personName}
                />
              }
            />
          ) : null}

          <OutcomeCard
            outcome={detail.outcome}
            noTools={noToolsSummary({
              callStatus: detail.status,
              personName: detail.personName,
              extraction: detail.extraction,
            })}
          />

          <ExtractionCard extraction={detail.extraction} />
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

If `PageProps<"/calls/[id]">` is not recognised, run `npm run dev` once to let
Next regenerate its route types, then stop it and typecheck again.

- [ ] **Step 4: Look at it**

Run: `npm run dev`, then open a Call from the Overview table's call link.

Check by eye: two columns above `lg` and stacked below; the transcript reads as
a conversation; the Outcome card lists the invocations; no horizontal scroll on
the page body at 375px.

- [ ] **Step 5: Commit**

```bash
git add "app/(app)/calls/[id]/page.tsx" components/calls/detail/call-header.tsx
git commit -m "Put the proof screen together"
```

---

## Task 19: Replace the Calls placeholder

**Files:**
- Create: `lib/calls/list.ts`
- Test: `lib/calls/list.test.ts`
- Modify: `app/(app)/calls/page.tsx`

- [ ] **Step 1: Write the failing test**

Create `lib/calls/list.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listCalls } from "@/lib/calls/list";
import { db, schema } from "@/lib/db";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

/*
  The Calls list. The sidebar has linked here since #1 and it has been a
  Placeholder ever since; leaving it would ship a dead link into the screen this
  ticket exists to show off.

  The test that matters is the same one `loadCallDetail` has: this reads across
  a whole Business, so a missing scope would list another account's Calls.
*/

const CLERK_ID = "user_test_call_list";
const OTHER_CLERK_ID = "user_test_call_list_other";
const STARTS_AT = new Date("2026-08-27T03:30:00.000Z");

let seed: ToolTestSeed;
let other: ToolTestSeed;

beforeEach(async () => {
  seed = await seedToolTest({ clerkId: CLERK_ID, appointmentStartsAt: STARTS_AT });
  other = await seedToolTest({
    clerkId: OTHER_CLERK_ID,
    appointmentStartsAt: STARTS_AT,
  });
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
  await cleanupToolTest(OTHER_CLERK_ID);
});

describe("listCalls", () => {
  it("returns only this Business's Calls", async () => {
    const rows = await listCalls(seed.businessId);

    expect(rows.map((row) => row.id)).toEqual([seed.callId]);
    expect(rows.map((row) => row.id)).not.toContain(other.callId);
  });

  it("carries the person and the Service off the Appointment", async () => {
    const [row] = await listCalls(seed.businessId);

    expect(row.personName).toBe("Priya Sharma");
    expect(row.serviceName).toBeTruthy();
  });

  it("returns the newest Call first", async () => {
    const [second] = await db
      .insert(schema.calls)
      .values({
        appointmentId: seed.appointmentId,
        callType: "web",
        attempt: 2,
        status: "queued",
      })
      .returning();

    const rows = await listCalls(seed.businessId);

    expect(rows[0].id).toBe(second.id);
  });

  it("returns an empty list for a Business that has never called", async () => {
    await db.delete(schema.calls);

    expect(await listCalls(seed.businessId)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/calls/list.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/calls/list"`.

- [ ] **Step 3: Write the query**

Create `lib/calls/list.ts`:

```ts
import { desc, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type { CallStatus } from "@/lib/db/schema";

/*
  Every Call this Business has placed, newest first.

  Deliberately small. This screen exists so the sidebar's Calls link is not a
  dead end and so there is a way into the proof screen that does not go through
  the Overview table — filters, sorting and pagination are a later ticket if
  they are ever one.

  Scoped through `appointments` inside the WHERE clause, like every other
  cross-table read in this app.
*/

export type CallListRow = {
  id: string;
  personName: string;
  serviceName: string;
  appointmentStartsAt: Date;
  timezone: string;
  status: CallStatus;
  attempt: number;
  durationSeconds: number | null;
  createdAt: Date | null;
};

export async function listCalls(businessId: string): Promise<CallListRow[]> {
  return db
    .select({
      id: schema.calls.id,
      personName: schema.appointments.name,
      serviceName: schema.services.name,
      appointmentStartsAt: schema.appointments.startsAt,
      timezone: schema.businesses.timezone,
      status: schema.calls.status,
      attempt: schema.calls.attempt,
      durationSeconds: schema.calls.durationSeconds,
      createdAt: schema.calls.createdAt,
    })
    .from(schema.calls)
    .innerJoin(
      schema.appointments,
      eq(schema.calls.appointmentId, schema.appointments.id),
    )
    .innerJoin(schema.services, eq(schema.appointments.serviceId, schema.services.id))
    .innerJoin(
      schema.businesses,
      eq(schema.appointments.businessId, schema.businesses.id),
    )
    .where(eq(schema.appointments.businessId, businessId))
    .orderBy(desc(schema.calls.createdAt));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/calls/list.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Replace the page**

Replace the whole contents of `app/(app)/calls/page.tsx`:

```tsx
import Link from "next/link"

import { CallStatusPill } from "@/components/calls/call-status-pill"
import { requireBusiness } from "@/lib/business/require-business"
import { formatDuration } from "@/lib/calls/duration"
import { listCalls } from "@/lib/calls/list"

/**
 * Every Call this Business has placed, each opening onto the proof screen.
 *
 * Stacked cards below `sm` and a table above it, per SPEC.md §11.4's 375px
 * floor. The whole row is a link rather than a "View" action in a last column:
 * there is exactly one thing to do with a Call, and a row-wide target is easier
 * to hit and easier to tab to.
 */
export default async function CallsPage() {
  const { business } = await requireBusiness()
  const calls = await listCalls(business.id)

  if (calls.length === 0) {
    return (
      <div className="rounded-card border border-line bg-surface p-6">
        <h1 className="text-section font-medium text-text">Calls</h1>
        <p className="mt-1 max-w-prose text-table text-text-muted">
          No Calls yet. Start one from the Quick Call card on Overview, and it
          will appear here with its recording, transcript and outcome.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-page font-medium text-text">Calls</h1>

      <ul className="flex flex-col gap-2">
        {calls.map((call) => (
          <li key={call.id}>
            <Link
              href={`/calls/${call.id}`}
              className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:flex-row sm:items-center sm:gap-6"
            >
              <span className="min-w-0 flex-1 truncate text-body text-text">
                {call.personName}
              </span>
              <span className="text-table text-text-muted sm:w-40 sm:shrink-0">
                {call.serviceName}
              </span>
              <span className="font-mono text-table text-text-muted tabular-nums sm:w-44 sm:shrink-0">
                {new Intl.DateTimeFormat("en-GB", {
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                  timeZone: call.timezone,
                }).format(call.appointmentStartsAt)}
              </span>
              <span className="font-mono text-table text-text-muted tabular-nums sm:w-16 sm:shrink-0">
                {formatDuration(call.durationSeconds)}
              </span>
              <span className="text-table text-text-muted sm:w-20 sm:shrink-0">
                Attempt {call.attempt}
              </span>
              <span className="sm:w-32 sm:shrink-0">
                <CallStatusPill status={call.status} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 6: Typecheck and look at it**

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run dev` and open `/calls`. Check the rows link through, and that the
page does not scroll sideways at 375px.

- [ ] **Step 7: Commit**

```bash
git add lib/calls/list.ts lib/calls/list.test.ts "app/(app)/calls/page.tsx"
git commit -m "Make the Calls link go somewhere"
```

---

## Task 20: Verify the whole ticket

**Files:** none — this task only runs things.

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS, every file. Report the actual count; do not claim a pass you
have not seen.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Replay every webhook fixture**

Run: `npm run replay-webhook`
Expected: every fixture drives cleanly, including the `book_slot` failure. This
is the check that the `transcript_object` change did not break #13.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: a successful production build. This is where an accidental client-only
import in a Server Component shows up.

- [ ] **Step 6: Walk the acceptance criteria by hand**

Run `npm run dev` and check each one against a real screen:

- A completed Call: transcript reads two-sided, timestamps in mono.
- A Call with a failed `book_slot`: it appears in the Outcome card, marked failed.
- A Call with no invocations: the card carries a sentence, not a blank.
- A Call whose extraction failed: amber card, raw output inside the collapsed block.
- A `no_answer` Call: reason and a Retry button; pressing Retry starts a Call.
- A Call whose `recording_url` is null: waiting panel, and the rest of the screen works.

To produce the last few without placing Calls, use `npm run replay-webhook` with
the `no-answer` and `failed` fixtures, and set `extractions.status` to `failed`
on one row through `npm run db:studio`.

- [ ] **Step 7: Update the design doc's status line**

In `docs/superpowers/specs/2026-08-21-call-detail-proof-screen-design.md`,
change the Status line to:

```markdown
**Status:** Implemented. See `docs/superpowers/plans/2026-08-21-call-detail-proof-screen.md`
```

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers/specs/2026-08-21-call-detail-proof-screen-design.md
git commit -m "Mark the proof screen design implemented"
```
