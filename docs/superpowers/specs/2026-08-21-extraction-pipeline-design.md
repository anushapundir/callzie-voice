# Design: Extraction pipeline — what was said

**Issue:** [#14](https://github.com/anushapundir/callzie/issues/14)
**Date:** 2026-08-21
**Status:** Implemented. See `docs/superpowers/plans/2026-08-21-extraction-pipeline.md`

## Summary

After the Call is over, one LLM pass reads the transcript and writes down the
things Tools cannot produce: notes, a summary, and sentiment. Voicemail is not
one of them — Retell already reports it, for free and reliably, so nothing is
inferred that has already been measured (`docs/verification.md` A9).

Extraction also carries two fallback fields, `confirmed` and `new_time`. They
exist for one case only: a Call where Maya talked to somebody and then failed to
invoke any Tool at all. Without them that Call produces nothing, and the person
who agreed to their appointment on the phone still shows as `pending`.

Three things this design is careful about.

**A committed Tool outcome always wins.** This is the rule that matters most
(SPEC.md §9 step 3). `tool_invocations` is what happened; extraction is what was
said about it. When they disagree, the record of what happened wins, and there is
no ordering of writes under which extraction can overwrite it.

**Extraction must never crash the pipeline.** SPEC.md §3 rule 5. A malformed
response gets one retry with a stricter instruction. A second failure stores the
raw output, marks the row `failed`, and leaves the Appointment exactly as the
Tools left it. Nothing here throws into the webhook path.

**No voice is involved in building it.** Four pasted transcripts and an injected
fake drive the whole test suite. Telephony spend for this ticket is zero, and
Anthropic spend in CI is zero.

## What already exists

Most of the surrounding machinery is built. This ticket adds the LLM step and the
fallback, and wires them into a handler that is already running.

| Already built | Where | What it gives us |
|---|---|---|
| The `extractions` table | `lib/db/schema.ts:239` | Every column this design writes, including `status` and `raw_llm_output` |
| The `call_analyzed` handler | `lib/webhooks/process.ts:123` | Runs after the 200, fills the transcript, and says in its own comment that extraction hangs off it |
| Processing after the response | `app/api/webhooks/retell/route.ts:78` | `after()` on Cloud Run with `--no-cpu-throttling`. See ADR-0012 |
| Delivery dedupe | `lib/webhooks/store.ts` | A redelivered event that was already handled does no work |
| The authoritative outcome record | `lib/tools/run.ts` | One transaction writes the Appointment and the `tool_invocations` row together |
| The status guard pattern | `lib/calls/record.ts:110` | `releaseAppointment` puts the status check inside the `WHERE`, not in a read-then-check |
| The env var and its panel row | `.env.example`, `lib/settings/env-status.ts` | `ANTHROPIC_API_KEY` is already declared, already required, already deployed |
| Model, price, and the JSON-schema call | `docs/verification.md` A11 | `claude-haiku-4-5`, ~$0.0016 per extraction, `output_config.format` |
| Network-free test Postgres | `vitest.globalSetup.ts` | A real database, on this machine, per run |

One new dependency: `@anthropic-ai/sdk`. Nothing new to wire into the deploy.

## Decisions taken during brainstorming

1. **The fallback writes a status. It never books.** `confirmed: true` sets
   `confirmed`; `confirmed: false` sets `declined`. A `new_time` is stored and
   flagged, but never moves the Appointment. Rejected: parsing `new_time` into a
   real Slot and rescheduling. That would mean an LLM writing a booking, which is
   exactly what ADR-0003 and SPEC.md §3 rule 7 push into Tools — and it would
   route around the exclusion constraint, the offer-replay check, and Google
   Calendar in one step.

2. **`confirmed: false` writes `declined`, which frees the Slot.** SPEC.md §14
   rule 2 says a Slot is never freed on a weak signal. A person saying "no, I
   can't make it" is not a weak signal — the rule's own example of one is an
   unanswered phone. The transcript is the evidence. This is the highest-
   consequence line in the ticket, and the two gates in part 4 exist largely to
   protect it.

3. **A voicemail still gets an LLM pass, but never a fallback outcome.** Maya
   leaves a message, so there is a transcript worth summarising. But nobody was
   on the line, so nothing in it can be an agreement. `in_voicemail === true`
   stops the outcome step dead. Rejected: skipping the LLM entirely, which is
   cheaper but leaves the Call detail screen (#16) blank for every voicemail.

4. **`new_time` reuses `needs_attention_reason = 'negotiation_truncated'`.**
   SPEC.md §5 defines it as "Call hit the 120s cap with no Tool committed". We
   are widening it to "no Tool committed during a negotiation", cap or no cap.
   Same failure, same fix, same UI surface. Recorded here rather than left to
   drift — see *Known limitations*.

5. **The LLM is an injected function, not a client.** `run.ts` takes
   `(input) => Promise<RawResponse>` as an argument. This is how the repo already
   handles anything external: `envStatus(env)`, `verifySignature(secret)`,
   `runTool({ handler })`. It is also why the tests need no API key, no network,
   and no `vi.mock` — of which there is currently not one in the codebase.

6. **Extraction runs inline in the `call_analyzed` handler.** The 200 has already
   gone back by the time `after()` runs, so a two-second LLM call costs Retell
   nothing. Rejected: a separate queue or endpoint, which is more moving parts
   than this milestone has a use for.

## Architecture

Five new files under `lib/extraction/`, each with one job.

| File | Job | Depends on |
|---|---|---|
| `prompt.ts` | Builds the prompt text and the JSON schema. Pure. | nothing |
| `parse.ts` | Raw string in, validated result or `null` out. Pure. | nothing |
| `llm.ts` | The Anthropic call. The only place `ANTHROPIC_API_KEY` is read. | `@anthropic-ai/sdk` |
| `run.ts` | Orchestrates: call, parse, retry once, write the row. Never throws. | the three above, `db` |
| `outcome.ts` | Decides whether a Tool already won, and applies the fallback if not. | `db` |

`llm.ts` mirrors `lib/retell/client.ts`: the key is read inside the factory, not
at module import, so a file that only needs the prompt or the parser can be
imported on a machine that has never held an Anthropic key.

The split between `run.ts` and `outcome.ts` is the important one. `run.ts` only
ever touches the `extractions` table. `outcome.ts` is the only thing in this
ticket that can write to `appointments`. A change to how the LLM is called cannot
reach the Appointment, and the rule that Tools win lives in one file.

### Two small changes to existing files

**`lib/webhooks/payload.ts`** gains `inVoicemail: boolean | null`, read from
`call.call_analysis.in_voicemail`. Only `call_analyzed` carries `call_analysis`
at all (`docs/verification.md` A9), so on the other two events it is `null` —
which is correct, not a gap.

**`lib/webhooks/process.ts`** — `applyAnalyzed` gains one call. Its existing
comment says extraction is "deliberately not here: this ticket ends at the Call
row". That comment is replaced by the thing it was describing.

## The flow

`call_analyzed` arrives. Signature verified, raw event stored, 200 returned,
`after()` runs `processWebhookEvent`. All of that exists. Inside `applyAnalyzed`,
once the transcript has been filled in:

1. **No transcript on the Call row → stop.** A no-answer Call has nothing to
   read. Note the transcript is taken from the row, not from this delivery: the
   row is where the `coalesce` fill-if-null write already put whichever event
   carried it first.
2. **An extraction row already exists → stop.** A redelivered `call_analyzed`
   must not pay for a second LLM call.
3. **Call `claude-haiku-4-5`** with `output_config.format` set to the JSON
   schema, and `max_tokens: 1024`.
4. **Check `stop_reason` before parsing.** Anything other than `end_turn` counts
   as malformed. A `max_tokens` truncation produces half an object, and a
   `refusal` produces something that will not match the schema — both would
   otherwise surface as a parse error one layer too late.
5. **Malformed → retry once**, with a "return only valid JSON" instruction
   appended. Malformed again → write the row with `status = 'failed'` and
   `raw_llm_output` set, and **return before the outcome step**. The Appointment
   is never touched.
6. **Good → write the row**: notes, summary, sentiment, `confirmed`, `new_time`,
   and `in_voicemail` taken from Retell rather than from the model.
7. **Then the outcome step**, and only then.

The whole of the above sits inside a `try`/`catch` that logs and swallows. A
timeout, a 429, a network failure, a bug in the parser — none of them may break
the Call row that `applyAnalyzed` already wrote.

### What the prompt is given

The transcript, plus the Appointment's scheduled time rendered in the Business's
timezone and the person's name. Without the scheduled time, "same time next
Tuesday" is unreadable and `new_time` comes back as a phrase nobody can act on.
`new_time` stays free text in the schema — resolving it to a Slot is not this
ticket's job, and per decision 1 it is not any ticket's job for extraction.

### Idempotency

`extractions.call_id` is `unique`. The pre-check in step 2 is the cheap path; the
constraint is the actual guarantee. The write uses `on conflict do nothing`, and
**if the insert conflicts, the outcome step is skipped** — another worker got
there first and has already applied it.

## The outcome step

Three gates, in order. Any one of them stops the write.

```
in_voicemail === true            → stop. Nobody was on the line.
a Tool committed                 → stop. The Tool wins (SPEC.md §9 step 3).
appointments.status ≠ 'pending'  → stop.
```

**"A Tool committed"** means a `tool_invocations` row for this Call with
`succeeded = true` and a `tool_name` in `book_slot`, `confirm_appointment`,
`cancel_appointment`. `check_availability` is a read — it commits nothing, and a
Call where Maya only ever checked times is a Call where no Tool committed. A Tool
that *ran and failed* also did not commit; SPEC.md §9 says a committed outcome
wins, and a `book_slot` that the exclusion constraint rejected has no outcome to
defend.

**The third gate is the same trick `releaseAppointment` uses.** The status check
lives inside the `WHERE` clause, not in a read followed by an `if`. It is
belt-and-braces behind the second gate: by the time `call_analyzed` lands,
`call_ended` has already run `releaseAppointment`, so an Appointment nobody
decided is back at `pending`. One that a Tool decided is at `confirmed`,
`rescheduled` or `cancelled`, and matches nothing.

Past the gates, `new_time` outranks `confirmed`:

| Extraction says | Appointment becomes | Slot |
|---|---|---|
| `new_time` is set | stays `pending`, gets `needs_attention_reason = 'negotiation_truncated'` | held |
| `confirmed: true` | `confirmed` | held |
| `confirmed: false` | `declined` | freed |
| `confirmed: null` | unchanged | held |

`new_time` wins because a person who named a new time did not agree to the old
one, whatever else the model returned in the same object.

## Testing

Four transcripts land in `fixtures/transcripts/`: confirm, reschedule, decline,
voicemail. They are used twice, for two different purposes.

**In `vitest`, with an injected fake.** Free, fast, deterministic, no API key in
CI. This is what proves the behaviour:

| Test | Proves |
|---|---|
| `parse.test.ts` | Valid object; missing field; wrong type; truncated JSON; unexpected extra key |
| `prompt.test.ts` | Transcript and appointment time reach the prompt; schema shape is what A11 documents |
| `run.test.ts` | Happy path writes `ok`; malformed → retry → success; malformed twice → `failed` with raw output stored; existing row → the fake is never called; no transcript → the fake is never called; a throwing fake does not propagate |
| `outcome.test.ts` | Each of the three gates stops the write; each row of the table above lands; a `failed` extraction changes nothing |

The Tool-wins case gets its own `describe.each` over the three committing Tools
crossed with what extraction returned, because "a committed Tool outcome always
wins" is the acceptance criterion with the most ways to be quietly wrong.

**In `scripts/try-extraction.ts`, against the real Claude Haiku.** This is what
proves the *prompt*, run by hand when the prompt changes. Roughly $0.0016 per
transcript, and it needs no Call, no phone number, and no webhook.

The split matters: the vitest suite can pass with a prompt that would confuse a
real model, and the script can pass while the fallback logic is broken. Neither
is a substitute for the other.

## Out of scope

- Rendering any of this. The Call detail screen is #16, Needs Attention is #15.
- Turning `new_time` into a real Slot, or booking anything. Decision 1.
- Retell's own `call_analysis.call_summary`. It overlaps with what Haiku
  produces; keeping both would mean two summaries and no rule for which one a
  screen shows.
- `user_sentiment` from Retell, for the same reason — SPEC.md §9 asks Haiku for
  sentiment, so Haiku is where it comes from.
- Retrying a `failed` extraction later. The row is stored and debuggable; a
  re-run mechanism is a feature nobody has asked for yet.
- The `unreachable` outcome and the final-attempt rule. #17.
- Rate limiting or backing off Anthropic. One extraction per completed Call is
  nowhere near any limit worth defending against.

## Known limitations, stated deliberately

- **A decline frees a Slot on an LLM's reading of a transcript.** Decision 2 says
  this is right and I still think so, but it is the one place in Callzie where a
  model's output releases something a human might have wanted held. The voicemail
  gate and the `pending` guard are the only things standing behind it.
- **`negotiation_truncated` now means more than SPEC.md §5 says it does.** The
  spec's wording is the 120-second cap; the code will also use it for "agreed a
  time, never called `book_slot`". Someone reading the spec next to the code will
  notice. Decision 4 is the record that it was on purpose.
- **A Tool that committed and then a person who changed their mind reads as the
  Tool.** If Maya books a Slot and the caller says "actually, forget it" thirty
  seconds later without a `cancel_appointment`, the booking stands and the
  extraction notes say otherwise. That is the correct behaviour under SPEC.md §9
  step 3, and it is still a surprise worth knowing about.
- **`new_time` is free text nobody parses.** "Thursday-ish" is a valid value. It
  raises a flag for a human and nothing more, which is the whole intent, but it
  means the Needs Attention row cannot say what time was agreed in any structured
  way.
- **Extraction failure is invisible until someone looks.** A `failed` row logs and
  sits there. Nothing pages, and nothing shows on the panel. Acceptable while the
  cost of a missed extraction is one Call's notes.
