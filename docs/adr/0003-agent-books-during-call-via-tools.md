# The Agent books during the Call, via Tools, against Callzie-owned Availability

Status: accepted

Callzie is the source of truth for Appointments — not a mirror of a booking held
elsewhere. The Agent is therefore given mid-Call Tools (`check_availability`,
`book_slot`, `cancel_appointment`) that read and write Callzie's own Postgres while the
conversation is still happening, so a person who cannot make their time is rebooked
before they hang up rather than leaving a note for a human to action later.

## Considered options

- **Post-call Extraction only** (the original `SPEC.md` shape). The Agent asks "what time
  works better?", the transcript is parsed afterwards, and `new_time` is stored as a
  human-readable string. Rejected: the Agent promises something the product cannot
  deliver — nothing is ever booked, and every Reschedule becomes manual work for the
  business. It also makes Callzie a system of action, which contradicts owning
  Appointments.
- **Google Calendar as the live Availability source.** The `check_availability` Tool
  queries Google mid-call. Rejected: a third-party network call sits on the critical path
  of a live conversation. A slow response is dead air while the caller waits, which is
  the most damaging failure mode available to a voice product.

## Consequences

- **The transactional outcome now comes from the Tool call, not from Extraction.**
  Extraction narrows to what Tools cannot produce — notes, sentiment, voicemail, summary
  — plus reconstructing the outcome when the Agent failed to invoke a Tool at all.
- **Slot uniqueness must be enforced by a database constraint, not application logic.**
  `SPEC.md` §5 permits three concurrent Calls; three Agents will find any gap left
  between a check and a write.
- **Business Hours are enforced inside the Tool, never in the prompt.** A prompt
  instruction is a suggestion; the same lesson `docs/verification.md` A4 records for
  `max_call_duration_ms`.
- Availability being a local Postgres query keeps the whole booking path testable with
  no network and no telephony spend, per `SPEC.md` §9.
