# The webhook processes in after(), not a self-POST

Status: accepted

`SPEC.md` §13 item 7 left one thing open and asked for it to be settled before
M4, which is this ticket: **does `after()` survive on Cloud Run?**

It does here, and the reason is already in the repo. `scripts/setup-infrastructure.sh:484`
deploys the service with `--no-cpu-throttling`, so the CPU stays allocated after
the response is sent. The trap `docs/verification.md` Decision 11 and ADR-0001
both warn about — Cloud Run withdrawing CPU the moment a response goes out, and
starving deferred work half-done — needs CPU throttling to be on. It is off.

So `app/api/webhooks/retell/route.ts` verifies the signature, stores the raw
event, returns 200, and does the work in `after()`. That is `SPEC.md` §3 rule 3
read literally: persist the raw event first, return 200 fast, process afterwards.

The deploy flag is now load-bearing. Turning it off would not break a build or
fail a test — it would make webhook processing intermittently stop halfway, which
surfaces as Call rows that never leave `in_progress`.

## Considered options

- **A fire-and-forget POST to `/api/internal/extract`**, which `SPEC.md` §3
  rule 3 offers as the escape hatch. Rejected: it buys nothing now that CPU is
  always allocated, and costs a second route, a second cold start on the same
  request, and `INTERNAL_SECRET` on a path that already has a stronger gate in
  the Retell signature. It also turns one failure mode into two — the work can
  now fail because the self-call failed.
- **Processing inline before returning 200.** Rejected, though it nearly wins:
  the work is two `UPDATE`s and would fit inside Retell's 10-second timeout with
  room to spare. But the timeout is Retell's to change, the work is ours to grow
  — issue #14 hangs an Anthropic call off `call_analyzed` — and a handler that
  fits today is a handler that stops fitting quietly. Deferring costs one line
  and never has to be revisited.
- **Enabling CPU-always-allocated as part of this change.** Not needed; it was
  already enabled, for its own reasons, before the question was asked.

## Consequences

- **A 200 does not mean the work is done.** Anything reading a Call row straight
  after a delivery has to wait for the state it expects rather than assume it.
  `scripts/replay-webhook.ts` polls for exactly this reason, and
  `app/api/webhooks/retell/route.test.ts` mocks `after()` so it can run the
  deferred callback deliberately.
- **A failure inside `after()` cannot be retried by Retell**, because Retell
  already has its 200. This is why `webhook_events.processed` is set *after* the
  work rather than before: the row stays open, so the next delivery — or a
  replay — picks it up. `lib/webhooks/store.ts` treats "stored but not
  processed" as work to do, not as a duplicate to skip.
- **Two deliveries can process the same event at once**, which follows directly
  from that rule. It is safe only because every write in `lib/webhooks/process.ts`
  sets a fixed value. Nothing there increments, appends or counts, and nothing
  added later may.
- **Vercel would need no change.** `after()` is native there via `waitUntil`
  (`docs/verification.md` C3), so this decision does not lock the deploy target
  in — it only records why the Cloud Run version of it is safe.
