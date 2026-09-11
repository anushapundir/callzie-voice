# Design: Call detail — the proof screen

**Issue:** [#16](https://github.com/anushapundir/callzie/issues/16)
**Date:** 2026-08-21
**Status:** Implemented. See `docs/superpowers/plans/2026-08-21-call-detail-proof-screen.md`

Two checks are still outstanding, both because this worktree has no `.env.local`:
`npm run replay-webhook`, which needs a running server and a database, and the
by-hand walk through the acceptance criteria in a browser. The route test
`app/api/webhooks/retell/route.test.ts` covers the same `call-analyzed` fixture
through the real signed handler, which is the offline half of the replay proof.

## Summary

One screen at `/calls/[id]` that proves a Call happened and shows exactly what
the Agent did. Two columns. On the left, a themed audio player and the
transcript as a two-sided conversation. On the right, the Outcome card built
from `tool_invocations`, the Extraction card below it, and a collapsed raw JSON
block below that.

Three things this design is careful about.

**The Outcome card is the point of the screen.** It is built from
`tool_invocations` — what the Agent *did*, mid-Call — and not from the
extraction, which is only what was said afterwards. SPEC.md §9 step 3 makes that
the product's central claim, and SPEC.md §16 step 5 makes it the thing the demo
says out loud. A card that quietly dropped a failed `book_slot` would be
undoing the claim.

**Failures are designed, not dumped.** A failed extraction is an amber card
saying what failed, with the raw output kept and readable. A failed or
no-answer Call gets a sentence a person can act on and a Retry button. Nothing
on this screen renders as an unstyled error, and nothing renders blank.

**The screen works before the data has all arrived.** Retell delivers the
transcript on `call_ended` and the recording on `call_analyzed`, minutes apart
(`docs/verification.md` A9 records the exact timing as unverified). Every block
that has no data yet renders its own waiting panel, and the page re-reads until
they land.

## What already exists

Almost all the data is already written. This ticket is mostly a reading and
rendering ticket, plus one column.

| Already built | Where | What it gives us |
|---|---|---|
| Every column the screen reads | `lib/db/schema.ts` | `calls`, `tool_invocations`, `extractions`, `appointments` |
| The webhook that fills them | `lib/webhooks/process.ts` | Status, duration, transcript, recording url |
| Failure classification | `lib/webhooks/status.ts` | `mapDisconnectionReason`, and `failureKind` for credit-exhausted vs concurrency-limit |
| The live Call machinery | `components/calls/live-call-provider.tsx` | Wraps the whole app shell, so Retry is a hook call |
| Attempt numbering | `lib/calls/start-web-call.ts:164` | A retry already writes `attempt: existing + 1` |
| The amber callout | `components/settings/section.tsx` | `SettingsCallout` with `tone="warning"`, on the Needs Attention orange |
| The status pill | `components/overview/status-pill.tsx` | Dot plus label, never colour alone |
| A day-view loader to copy | `lib/schedule/load-day.ts` | The house pattern: one server-side loader, dumb components |
| Component tests that run | `components/schedule/day-grid.test.tsx` | React testing already works in this repo |
| Fixtures and a replay script | `fixtures/retell/webhooks/` | The only honest way to prove a webhook change |

No new dependencies. Nothing new to wire into the deploy.

## Decisions taken during brainstorming

1. **Per-turn timestamps come from Retell, not from guesswork.** Retell sends
   `transcript_object` on `call_analyzed` — an array of `{ role, content, words }`
   where each word carries `start` and `end`. We add a nullable `transcript_turns`
   jsonb column and keep `role`, `content`, and the first word's `start`.
   Rejected: showing only the player's position readout in mono and leaving turns
   unstamped. Cheaper, and no migration, but the issue's first acceptance
   criterion asks for mono timestamps on the transcript itself.

2. **The plain-text transcript stays the fallback, permanently.** When
   `transcript_turns` is null the renderer parses the stored `transcript` text on
   its `Agent:` / `User:` line prefixes. This is not only for rows written before
   the migration: `call_ended` carries the text transcript while `call_analyzed`
   carries the object, so there is a real window on every Call where the fallback
   is the only thing there is.

3. **One server-side loader, dumb components.** `lib/calls/detail.ts` reads
   everything in one pass and returns a plain object. Every derivation is a pure
   function beside it with its own test. Rejected: each card running its own
   query, which makes five round trips and leaves no derivation testable without
   mounting a component. Also rejected: deriving in `page.tsx`, which is how a
   400-line page component happens.

4. **Retry starts a new Call and navigates to it.** `startWebCall` already
   increments `attempt`, so a retry is a second `calls` row with its own id. The
   old Call stays readable at its own URL as the record of the failed attempt,
   and an `Attempt 2 of 2` line links between them. Rejected: staying on the dead
   Call with a banner, which leaves you reading a finished Call while a live one
   runs.

5. **Credit exhaustion offers no Retry.** `failureKind` already separates it.
   Retrying cannot work until somebody tops up the Retell balance, and a button
   that cannot succeed is worse than no button.

6. **The page polls while anything is outstanding, and then stops.** Every 5s,
   the same interval Overview uses, while the Call is unsettled or its transcript
   or recording is still missing. Rejected: a "Check again" button, which needs
   somebody to press it during the demo.

7. **`/calls` gets a minimal list, not a full screen.** The sidebar links to it
   and it is still a `Placeholder`, so leaving it would ship a dead link into the
   screen this ticket exists to show off. One row per Call, newest first, linking
   into the detail. No filters, no pagination, no sorting — that is a later
   ticket if it is ever one.

## The migration

One column, nullable, no backfill.

```sql
ALTER TABLE calls ADD COLUMN transcript_turns jsonb;
```

Three edits go with it.

`lib/webhooks/payload.ts` reads `call.transcript_object` into a
`transcriptTurns: TranscriptTurn[] | null` field. It keeps `role`, `content` and
the first word's `start`, and drops the rest of the word timings, which nothing
on this screen uses. It stays null-on-anything-malformed, exactly like every
other field in that file — a bad `transcript_object` costs us timestamps and
never costs us the delivery.

`lib/webhooks/process.ts` writes it under the same `coalesce` rule the existing
`transcript` write uses, so a redelivered `call_analyzed` cannot blank a column
an earlier delivery filled.

`fixtures/retell/webhooks/call-analyzed.json` gains a `transcript_object` whose
turns match the `transcript` string already in that file. The existing replay
script then drives it, which is the check that matters: it proves the column is
populated by the real pipeline rather than by a fixture written to match the
parser.

### The risk this carries

#13 was signed off by replay, and this reopens it. Two guards.

The parser cannot throw. Anything that is not an array of objects with a string
`role` and a string `content` yields null, and null means "we have no turns",
which the fallback already handles.

The screen never requires the column. Every acceptance criterion on this issue
is met on a row where `transcript_turns` is null, minus the per-turn stamps.

## The pure functions

Five files in `lib/calls/`, each testable without rendering anything. This is
where the acceptance criteria actually live.

**`transcript.ts`** — produces `{ speaker: "agent" | "person", text,
startSeconds: number | null }[]`. Prefers `transcript_turns`; falls back to the
plain text. A line with no `Agent:` / `User:` prefix joins the turn above it
rather than being dropped — a transcript missing a sentence is worse than an
ugly one. Retell's `role` is `agent` or `user`; we render the second as the
person, whose name comes from the Appointment.

**`outcome.ts`** — walks `tool_invocations` in `created_at` order and returns
the Outcome card's model: every invocation with its `toolName`, `arguments`,
`result`, `succeeded` and `latencyMs`; the Slots every `check_availability`
returned, deduped in first-seen order; and the time a successful `book_slot`
committed. **Failed invocations stay in the list**, in place. A `book_slot` that
failed is the most interesting row the card can hold.

**`no-tools.ts`** — the empty case, which must never render blank. Four inputs,
four different sentences: no Tools with an `ok` extraction points at the
extraction's fallback fields, which is exactly what `lib/extraction/outcome.ts`
used to move the Appointment; no Tools with `in_voicemail` says a machine picked
up; no Tools with a failed extraction says we do not know and points at the
amber card; no Tools on a Call that never connected defers to the failure card.

**`failure-reason.ts`** — one sentence per `disconnect_reason`, plus whether
Retry is offered. Wraps `failureKind` rather than re-deriving it. Every reason
in `docs/verification.md` A9 is covered, and an unrecognised reason gets a
generic sentence and an offered Retry, matching how `mapDisconnectionReason`
fails closed.

**`duration.ts`** — seconds to `mm:ss`. Used by the player, the turn stamps, the
header and the list, and mono alignment depends on it never returning `1:5`.

## The screen

`app/(app)/calls/[id]/page.tsx` — a Server Component. It calls
`loadCallDetail(business.id, params.id)`, which scopes through `appointments` to
the Business inside the `WHERE` clause the way `lib/business/active-calls.ts`
does. A Call belonging to another account is `notFound()`, not a 403: the id
arrives from the URL and this app is open signup.

### Header

The person's name, the Service, the Appointment time, the Call's status pill,
and `Attempt 2 of 2` when there is more than one — the second half links to the
sibling Call. Times and duration in mono.

### Left column

**The player.** A styled `<audio>` on `recording_url`, with position and total
duration in mono as `00:42 / 01:35`. When `recording_url` is null it is replaced
by a quiet panel saying the recording is not ready yet, and no `<audio>` element
is rendered at all.

**The transcript.** Agent turns on the left behind a small teal avatar dot; the
person's turns on the right. Timestamps in mono, in the gutter opposite the
speaker, omitted entirely when the turn has no time rather than rendered as a
placeholder. When there is no transcript at all, its own waiting panel.

### Right column

**The failure card, when the Call is `failed` or `no_answer`.** It sits above
the other two, because on a Call that never connected it is the only card with
anything to say. It carries the sentence from `failure-reason.ts` and a Retry
button, and it uses the amber callout — this is a thing a person has to act on,
which is what SPEC.md §11.4 reserves inline persistent UI for.

**The Outcome card.** Every Tool invocation in order: the Tool's name, a success
or failure mark, the latency in mono, and its arguments and result as small
labelled rows rather than raw JSON. Beneath the list, two summary lines — the
Slots this Call offered, and the time it booked. When no Tool ran, the list is
replaced by the `no-tools.ts` sentence.

**The Extraction card.** Notes, summary and sentiment, then a collapsed
`<details>` holding the raw JSON in mono. When `extractions.status` is `failed`
the whole card turns amber, says extraction failed, says the Call's recorded
outcome is unaffected, and puts `raw_llm_output` inside the collapsed block.
When there is no extraction row yet, a waiting panel.

### Retry

The button calls `useLiveCall().start({ appointmentId, name })` — the provider
already wraps the app shell — and routes to `/calls/<new id>` once the new Call
has an id. It is disabled while any Call is in flight, for the same reason
`CallNowButton` is: there is one bar and one Call.

### Polling

A small client component calls `router.refresh()` every 5s while the Call is
`queued`, `ringing` or `in_progress`, or while it has ended and its transcript
or recording is still missing. It renders nothing and unmounts its interval
once there is nothing outstanding.

### One small tidy

`SettingsCallout` is already the amber callout this screen needs, and it is not
really about Settings. It moves to `components/ui/callout.tsx` as `Callout`,
with a one-line re-export left behind so Settings keeps working unchanged.

## The list at `/calls`

Replaces the `Placeholder`. One row per Call for this Business, newest first:
the person's name, the Appointment time in mono, the Call's status pill, the
attempt number, the duration in mono, each row linking to the detail. Stacks to
cards below 640px, like every other table in this app.

## Testing

**Pure tests, no rendering.**

- `transcript.ts`: a row with `transcript_turns` produces stamped turns; a row
  with only the plain text produces the same turns with `null` times; an
  unprefixed continuation line joins the turn above it; a single-line transcript
  produces one turn; a malformed `transcript_turns` falls back rather than
  throwing.
- `outcome.ts`: a failed `book_slot` still appears in the list, in order; three
  `check_availability` calls produce a deduped offered-Slot list; a successful
  `book_slot` produces the booked time; an empty invocation list produces an
  empty model rather than a thrown error.
- `no-tools.ts`: all four inputs produce their four distinct sentences.
- `failure-reason.ts`: one case per reason in `docs/verification.md` A9;
  credit-exhausted offers no Retry; an unknown reason offers one.
- `duration.ts`: `65` is `01:05`, `0` is `00:00`, null is em-dash.

**Component tests.**

- The transcript renders two-sided, with mono timestamps present.
- The Outcome card renders a failed invocation visibly as failed.
- An Outcome card with no invocations renders a sentence, not nothing.
- A failed extraction renders amber and its raw output is present in the
  collapsed block.
- A Call with `recording_url` null renders the waiting panel and no `<audio>`.
- A `no_answer` Call renders its reason and a Retry button.

**Replay.** `call-analyzed.json` gains `transcript_object`, and the existing
replay script drives it end to end.

**Not tested.** Audio playback — jsdom has no media element worth asserting on,
and the player is a styled `<audio>`. The polling component gets no timer test;
it is a `setInterval` around `router.refresh()`.

## Acceptance criteria, mapped

| Criterion | Met by |
|---|---|
| Transcript renders two-sided with mono timestamps | `transcript.ts` + the transcript component, and the `transcript_turns` column feeding it |
| Outcome card shows every Tool invocation in order, including failed | `outcome.ts` keeps failures in place; its test asserts it |
| A Call where the Agent invoked nothing renders sensibly | `no-tools.ts`, four sentences for four situations |
| A failed extraction renders as a designed amber card with raw output | The Extraction card's `failed` branch on `Callout` |
| Failed and no-answer Calls show the reason and offer Retry | `failure-reason.ts` + the failure card, minus Retry on credit exhaustion |
| The recording plays, and the screen works before the url arrives | The player's waiting panel, plus the 5s poll |
