# Google Calendar is a one-way push with Collision detection

Status: accepted

Callzie writes an Appointment to its own Postgres first, then pushes an event to the
Business's connected Google Calendar and reads that window back to detect overlap. Google
never changes Callzie's state: an event the owner creates directly in Google does not
remove a Slot from Availability. Where the two disagree, Callzie raises a **Collision**,
marks the Appointment **Needs Attention**, and stops calling that person until a human
clears it.

Google Calendar permits overlapping events and its
[`events.insert` reference](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)
documents no conflict handling, so detection is a deliberate second read, not something
the write reports.

## Considered options

- **Bidirectional sync** — ingesting Google changes via push channels so owner-created
  events remove Slots from Availability. Rejected, but not on cost: it is free, and
  because ingestion happens out of band it adds no latency to a live Call. It was
  rejected because it is **strictly additive** — notifications arrive asynchronously, so
  collisions remain possible and every part of the one-way design (Collision, Needs
  Attention, human review) is still required. It therefore forecloses nothing and can be
  layered on later without reworking the booking path. Its real costs are silent-failure
  modes: watch channels expire and must be renewed, a lapsed renewal leaves Callzie
  believing stale Availability is authoritative, Google requires the push receiver to sit
  on a verified domain, and Callzie's own writes echo back as inbound changes and need a
  guard.
- **Google as the live Availability source**, queried by the Agent mid-Call. Rejected in
  [ADR-0003](./0003-agent-books-during-call-via-tools.md) — a third-party call on the
  critical path of a conversation is dead air.

## Consequences

- **Callzie detects calendar collisions; it does not prevent them.** This belongs in the
  README as a stated limitation, not an omission.
- The `calendar.events` scope is classified sensitive and requires Google OAuth app
  verification before public use, which reportedly runs to weeks. The integration
  therefore ships **behind a flag with the app in Testing status**, connected only to the
  builder's own account, and **Callzie must be fully functional for a Business that never
  connects Google.**
