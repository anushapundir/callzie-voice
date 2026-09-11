# Retell webhook fixtures

The body Retell POSTs to `/api/webhooks/retell`: `{ event, call }` — the event
name and the call object. Built from the verbatim `call_ended` example in
`docs/verification.md` A7, which is the shape Retell's own docs publish.

`call` carries far more than this in reality. Only the fields Callzie writes to a
`calls` row are kept, so a change to the rest of Retell's payload cannot make
these files wrong. The receiver stores the whole body it was sent regardless
(`webhook_events.payload`), so nothing is lost by trimming here.

## Placeholders

Three, replaced by whoever drives the fixture — `lib/webhooks/fixtures.ts` does
it for both the tests and the replay script:

| Placeholder | Becomes |
|---|---|
| `CALL_ID_PLACEHOLDER` | Retell's call id — `calls.retell_call_id` |
| `CALLZIE_CALL_ID_PLACEHOLDER` | `calls.id`, which real payloads carry in `metadata.call_id` |
| `APPOINTMENT_ID_PLACEHOLDER` | `appointments.id` |

Nothing here is a real call id, and no fixture describes a Call that was ever
placed.

## The files

| File | The state it drives |
|---|---|
| `call-started.json` | queued → in progress |
| `call-ended-completed.json` | `user_hangup`, with a full transcript and a 95-second duration |
| `call-ended-no-answer.json` | `dial_no_answer` — nobody picked up, no transcript. Driven **twice** by the replay, at attempt 1 and attempt 2 of one Appointment (#17) |
| `call-ended-failed.json` | `error_user_not_joined` — the web-call access token expired (#11) |
| `call-ended-credit-exhausted.json` | `no_valid_payment` — the Retell balance is gone |
| `call-ended-concurrency.json` | `concurrency_limit_reached` — too many Calls at once |
| `call-analyzed.json` | carries the `recording_url` and `call_analysis` |

`recording_url` is deliberately `null` on every `call_ended` and set on
`call_analyzed`. `docs/verification.md` A9 records its timing as **unverified** —
no Retell page says which event carries it first — so the receiver takes
whichever one has it, and these fixtures prove the harder direction.

## Duplicate delivery

SPEC.md §10 lists it as a required fixture. It is not a file here: a
byte-identical copy of `call-ended-completed.json` would prove nothing. Duplicate
delivery is that fixture sent **twice**, which is what
`app/api/webhooks/retell/route.test.ts` and `scripts/replay-webhook.ts` both do.

## The retry chain

A no-answer is not just a status. `lib/webhooks/process.ts` gives the first one
a retry and the second one a human — and the Appointment keeps its Slot either
way (SPEC.md §14 rule 2).

Proving that needs the same fixture delivered to two different Calls, because
the dedupe key is `(retell_call_id, event_type)` and a second delivery to the
same Call is by design a no-op. `scripts/replay-webhook.ts` builds its own
throwaway Appointment for this, so marking it unreachable disturbs nothing else
in the run.

## Timestamps

Fixed, and in the past — `start_timestamp` is 2026-08-20 09:00:00 UTC and the
Call runs 95 seconds. That is payload data and nothing checks it against a clock.

The **signature** timestamp is a different thing entirely and must be current:
Retell's scheme only accepts a signature within five minutes of the moment it was
signed (`docs/verification.md` A8 point 4). Both drivers sign at the moment they
run, which is why no signature is stored in this directory.

## Driving them

Offline, in CI, through the real route handler:

```
npm test app/api/webhooks/retell/route.test.ts
```

Over real HTTP, against a running app — the only thing that proves `proxy.ts`
lets a delivery through:

```
npm run dev
npm run replay-webhook
```
