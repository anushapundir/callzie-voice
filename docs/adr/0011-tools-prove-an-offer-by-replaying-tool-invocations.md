# Tools prove an Offer by replaying tool_invocations, and cap Reschedules with an index

Status: accepted

Two rules `SPEC.md` states in prose needed a mechanism, and both ended up in the
same place: the `tool_invocations` table Callzie was already required to write.

**Only a Slot this Call was Offered may be booked.** `check_availability` returns
`slot_start`; `book_slot` echoes it back; the endpoint reads that Call's earlier
`check_availability` rows and refuses anything that does not appear in one. So
`SPEC.md` §7's "Only ever offer times `check_availability` returned" is enforced
rather than requested — §3 rule 6's lesson, that a prompt instruction is a
suggestion. It also keeps date arithmetic out of an LLM's hands, because the
model copies a token instead of composing a datetime.

**Exactly one Reschedule commits per Call.** A partial unique index on
`tool_invocations (call_id) WHERE tool_name = 'book_slot' AND succeeded`. Every
Tool therefore runs inside one transaction that also writes its own record: when
the index refuses the second booking's record, the booking rolls back with it.
There is no ordering of the two writes that could leave them disagreeing.

## Considered options

- **Signing each `slot_start` with `INTERNAL_SECRET`.** Stateless, one fewer
  query. Rejected: it adds a second secret-signing scheme beside
  `lib/google/oauth.ts`, and the record it would replace has to be written
  anyway. A cache is a second copy of the truth, and a second copy can disagree
  with the first.
- **Checking the Offer and the booking count in application code.** Rejected for
  the count: it is check-then-write, the pattern `SPEC.md` §3 rule 8 exists to
  rule out, and a check nothing tests is a check someone deletes.
  `lib/tools/one-booking.test.ts` drops the index and watches two Reschedules
  commit, which is what proves the guarantee is not accidentally in the code.
- **Deriving "already booked" from `appointments.status = 'rescheduled'`.**
  Rejected: it says nothing about the Call, so a human rescheduling the row
  between two Calls would block the second Call's Agent from doing its job.
- **Parsing `preferred_time`.** Deferred, not rejected. The argument is recorded
  so the phrases people actually use can be read off the table before a parser is
  written for imagined ones.

## Consequences

- **`tool_invocations` is load-bearing, not an audit log.** It was already the
  authoritative record of the outcome (`SPEC.md` §9 step 3); it is now also an
  input to `book_slot`. Anything that prunes or archives it changes behaviour.
- **A constraint rejection needs a savepoint.** Postgres aborts a whole
  transaction on a failed statement, so `SPEC.md` §8's silent retry, the
  `book_failed` write and the record itself would all fail after a lost race.
  `lib/appointments/reschedule.ts` runs each attempt on its own savepoint — a
  marker inside a transaction you can roll back to without losing the
  transaction.
- **A failed Tool's record is written outside the transaction.** On a fresh
  connection, or it would roll back along with the failure it describes and the
  Call would show an Agent that invoked nothing.
- **Every read a Tool makes goes through its own transaction, never through the
  pool.** Running each Tool in a transaction means it is already holding one of
  the pool's five connections, so a helper that reads through `db` takes a
  second. Enough simultaneous Tool calls and every connection is held by a
  transaction waiting for another that will never come free: Postgres idle, the
  app deadlocked, and every request hanging until `connectionTimeoutMillis`
  gives up ten seconds later. Ten seconds is longer than a Tool's whole budget,
  so on this path that is dead air on a live call. `Queryable` in
  `lib/db/index.ts` is what closes it, and
  `lib/tools/concurrency.test.ts` fires more calls at once than the pool holds —
  it fails if the second connection ever creeps back in.
- **Both `Authorization` and `X-Callzie-Secret` are accepted**, because
  `docs/verification.md` A12 records it as unverified whether Retell forwards the
  first unmodified. The cost is a few lines; the alternative is finding out
  during a live call and re-provisioning four Agents to fix it.
- **The Offer check is per Call, not per Offer.** A time named in turn two stays
  bookable in turn nine — "actually, the first one you said" is a real thing
  people say.
- **A request whose `call_id` resolves to nothing leaves no trace.**
  `tool_invocations.call_id` is `NOT NULL` with a foreign key, so there is no row
  to write. The alternative — a nullable `call_id` — would make every reader of
  that table handle a case that only ever means "someone posted garbage".
