# Retell Tool-call fixtures

The body Retell POSTs to a custom tool: `{ name, call, args }` — the tool name,
the full call object *including the transcript so far*, and the arguments as a
JSON object. Verified against `retell-sdk@5.62.0`'s own type declarations; see
`docs/verification.md` A12.

`call` carries far more than this in reality. Only `call_id` is read, and only
these fields are kept, so a change to the rest of Retell's payload cannot make
these files wrong.

`CALL_ID_PLACEHOLDER` and `SLOT_START_PLACEHOLDER` are replaced by the test with
values from the rows it seeded. Nothing here is a real call id.

SPEC.md §10 requires every Tool path to be driveable without placing a Call.
`app/api/tools/routes.test.ts` is what does it.

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
