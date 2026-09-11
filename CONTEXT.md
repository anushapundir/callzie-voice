# Callzie

Callzie places outbound AI voice calls to people who hold a booking with a small
appointment-based business, and turns each conversation into structured data.

This glossary is the project's ubiquitous language. It is not a spec — see `SPEC.md`
for scope and `docs/adr/` for decisions.

## Business setup

**Business**:
The company that holds a Callzie account. Exactly one Business per account, and one
login shared by everyone who works its front desk.
_Avoid_: organization, tenant, workspace, practice, client

**User**:
The single login behind a Business — one `users` row, created the first time a Clerk
account signs in. "User" always means that row, never the Clerk-side account it points
at, and never the person on the other end of a Call, who belongs to an Appointment.
_Avoid_: member, seat, admin, owner, teammate

**Business Hours**:
The recurring weekly window during which a Business accepts Appointments.
_Avoid_: schedule, opening hours, working hours

**Service**:
A kind of Appointment a Business offers, carrying a duration. A cleaning, a haircut,
an hour of tutoring.
_Avoid_: treatment, job, session, offering

**Business Type**:
The category of appointment business an account belongs to — one of clinic, salon,
home services, or tutoring. Chosen once during Onboarding, and changeable in Settings
without migrating any data.
_Avoid_: vertical, industry, niche, segment

**Template**:
Everything that ships with a Business Type: the agent prompt and voice persona, plus
the starting Business Hours, Services and example Appointments an account is seeded
with at Onboarding. Curated by the Callzie team; an account selects one and never
authors one.
_Avoid_: preset, profile, config, persona (on its own)

**Onboarding**:
The one screen a new account passes through before it can use the product — pick a
Business Type, name the Business, choose an IANA timezone. It writes the `businesses`
row and everything the chosen Template seeds, then lands on Overview, never on an
empty table. An account with no Business is routed here from anywhere in the app.
_Avoid_: setup wizard, first-run, signup (which is the Clerk-side account creation)

## Calling

**Call**:
One voice conversation, in either direction. A Call has exactly one Retell call behind
it. An outbound Call is one attempt to reach a person about a single Appointment, and a
second attempt is a second Call; an **Inbound Call** is one somebody placed to the
Business.
_Avoid_: dial, attempt (as a noun), session

**Inbound Call**:
A Call Callzie receives rather than places. It has no Appointment when it starts and may
never acquire one — somebody ringing to ask what time you close is a Call about nothing
that is booked. Maya answers around the clock; whether the Business is open changes what
she says, not whether she answers.
_Avoid_: incoming call, received call, answered call

**Caller**:
The person on an Inbound Call. Distinct from the person an Appointment names, who
Callzie already knows about — a Caller is a stranger until they give a name, and may
never give one.
_Avoid_: customer, lead, contact, the user

**Web Call**:
A Call carried over the browser to whoever is at the screen. The default for every
account, and the only kind an unflagged account may place.
_Avoid_: browser call, demo call, test call

**Phone Call**:
A Call carried over telephony to a number the Business supplied. Restricted to flagged
accounts.
_Avoid_: real call, outbound call, PSTN call

**Agent**:
The AI voice persona that conducts a Call. Named Maya. One Agent configuration exists
per Template.
_Avoid_: bot, assistant, AI, voice

**Quota**:
The number of Calls an account is permitted to place. Displayed in the sidebar.
_Avoid_: credits, limit, allowance, balance

## Scheduling

**Appointment**:
A booking Callzie owns — a named person, a Service, and a start time. Callzie is the
source of truth for it, not a mirror of a booking held elsewhere.
_Avoid_: booking, reservation, event, meeting

**Slot**:
A discrete bookable window in a Business's schedule, sized by a Service's duration.
_Avoid_: opening, time, spot

**Availability**:
The set of Slots inside Business Hours not already held by an Appointment.
_Avoid_: openings, free time, calendar

**Offer**:
A Slot the Agent proposes to the person during a Call. Offers are free and repeatable —
a Call may contain several before one is accepted.
_Avoid_: suggestion, option, proposal

**Reschedule**:
Moving an existing Appointment from one Slot to another. When the Agent does this
during a Call it is a completed action, not a request for a human to action later.
One Reschedule commits per Call, however many Offers preceded it.
_Avoid_: rebook, move, change, reschedule request

**Collision**:
A Callzie Appointment whose Slot overlaps something on the Business's connected Google
Calendar. Callzie detects and surfaces Collisions; it never resolves them.
_Avoid_: conflict, clash, double-booking, overlap

**Needs Attention**:
The state of an Appointment that Callzie will not act on again until a human clears it.
Carries a reason. Callzie never resolves a Needs Attention itself, and never frees the
Slot while one is open.
_Avoid_: error, flagged, stuck, review required, at-risk

## Outcomes

**Tool**:
A function the Agent may invoke mid-Call to read Availability or write an Appointment.
Distinct from Extraction, which runs only after the Call ends.
_Avoid_: function, action, skill, capability

**Extraction**:
The structured result produced from a completed Call's transcript by an LLM after the
call ends — distinct from anything the Agent decides during the call.
_Avoid_: parse, analysis, summary (as a name for the whole thing)

**Enquiry**:
What an Inbound Call produced: a booking, a question answered, a complaint, a request
for a callback, or something Maya declined to help with. Written by a Tool during the
Call, so it survives a failed Extraction — the same rule that makes a Tool the
authority on an outcome. One Enquiry per Call. An unresolved Enquiry waits for a human
and Callzie never resolves one itself.
_Avoid_: message, ticket, note, lead, voicemail
