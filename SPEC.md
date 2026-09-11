# Callzie — Build Spec for Claude Code

Handover document. Read fully before writing any code. Follow the milestone order exactly.
Scope is locked: if a feature is not in this document, do not build it.

Read alongside this: `CONTEXT.md` (the glossary — use its terms, avoid the ones it lists
under `_Avoid_`), `docs/adr/` (decisions and the alternatives that were rejected), and
`docs/verification.md` (primary-source facts about Retell, Postgres, and deployment).

---

## 1. What This Is

A self-serve web app for small appointment businesses — clinics, salons, home services,
tutoring — that **calls the people who hold bookings and rebooks them during the call.**

Callzie owns the calendar rather than mirroring one. An AI voice Agent named Maya calls a
person, checks real Availability mid-conversation, offers Slots until one lands, and
commits the Reschedule before they hang up. A post-call extraction pass captures what the
tool call could not: notes, sentiment, voicemail, summary. Anything Callzie cannot do
confidently, it refuses to guess at and marks **Needs Attention** for a human.

Anyone can sign up. Every account gets five Calls. Signups get **Web Calls** — Maya in the
browser. **Phone Calls** are restricted to flagged accounts (see §3 rule 9).

**Deliverables (all three required):**
1. Live deployed URL, open to signup
2. Clean repo with README — architecture diagram, "why managed voice", the refusal list
   (§14), and the stated limitations
3. A live demo: pick a Business Type, place a call, watch Maya rebook someone into a real
   Slot, and see the row change before the call ends

**Builder context:** free tier only. Real Calls cost credits, so all logic must be
testable against fixtures without placing Calls (see §10).

---

## 2. Stack (fixed, do not substitute)

| Layer | Choice | Notes |
|---|---|---|
| Framework | Next.js **16**, App Router, TypeScript | Version per ADR-0002. Deploy target per ADR-0001 |
| Styling | Tailwind + shadcn/ui | Restyled with §11's tokens |
| DB | Postgres, Drizzle ORM | Migrations checked into repo. Needs `btree_gist` for §5's exclusion constraint |
| Auth | Clerk, **open signup** | No orgs, no invites, no roles (§14 rule 9) |
| Voice | Retell AI | Agent + Tools created via API. Web Calls default; Phone Calls flagged |
| Extraction LLM | Claude Haiku (Anthropic API) with JSON output | Fallback: any cheap model with JSON mode |
| Calendar | Google Calendar, **one-way push, behind a flag** | ADR-0004. App stays in Testing status |
| CSV parsing | PapaParse, client-side | |

Environment variables for `.env.example`: `DATABASE_URL`, `RETELL_API_KEY`,
`RETELL_AGENT_ID`, `RETELL_FROM_NUMBER`, `RETELL_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`,
Clerk keys, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_URL`, `INTERNAL_SECRET`.

---

## 3. Hard Rules

1. **Never hardcode secrets.** Everything through env vars.
2. **Webhook handler must be idempotent.** Retell may deliver events more than once.
   Dedupe on `(retell_call_id, event_type)` via `webhook_events`.
3. **Webhook handler must return 200 fast.** Persist the raw event first, process after.
4. **Verify Retell webhook signatures.** Header `X-Retell-Signature`, HMAC-SHA256 over
   `rawBody + timestamp`. `Retell.verify()` is **async — `await` it**; forgetting makes
   the handler accept every forged payload. Use the raw body, never re-serialised JSON.
   See `docs/verification.md` A8. Reject invalid payloads with 401.
5. **Extraction must never crash the pipeline.** Malformed LLM output → store raw
   response, mark extraction failed, surface a visible failure state. Extraction failure
   must never lose an outcome a Tool already committed.
6. **Business Hours are enforced inside the Tool, never in the prompt.** A prompt
   instruction is a suggestion. Same lesson as `max_call_duration_ms`.
7. **Maya must never state that a booking succeeded when the Tool call failed.** This is
   the most damaging failure available to this product. See §8.
8. **Slot uniqueness is a database constraint, not application logic.** Three concurrent
   Agents will find any gap between a check and a write.
9. **Never place a Phone Call from an account without `phone_calls_enabled`.** Open signup
   plus arbitrary outbound dialling is a robocalling tool.
10. **All phone numbers stored as E.164.** Validate on upload; reject bad rows with a
    per-row error report.
11. **Do not place real Calls during automated tests.** Real Calls only via explicit
    manual user action.
12. **Verify against current Retell and Google docs before implementing** payloads, tool
    schemas, dynamic variable syntax, and webhook event names. Names here are descriptive,
    not authoritative.

---

## 4. Business Types and Templates

Four Business Types ship: **clinic**, **salon**, **home services**, **tutoring**. Each has
a **Template** — an Agent prompt and voice persona, authored by us. A Business picks one
during onboarding and can change it in Settings. **Users never author a prompt** (§14
rule 5).

The prompt varies by Template. **The extraction schema does not** — a salon confirming a
haircut and a clinic confirming a cleaning produce the same fields. Four Templates cost
four strings, not four pipelines.

---

## 5. Data Model (Drizzle → Postgres)

```sql
users (
  id uuid PK, clerk_id text unique not null, email text,
  created_at timestamptz default now()
)

businesses (
  id uuid PK,
  user_id uuid FK -> users unique not null,   -- one Business per account
  name text not null,
  business_type text not null,       -- clinic | salon | home_services | tutoring
  timezone text not null,            -- IANA, e.g. 'Asia/Kolkata'. Business Hours are local
  call_quota int not null default 5,
  calls_used int not null default 0,
  phone_calls_enabled boolean not null default false,   -- §3 rule 9
  is_admin boolean not null default false,              -- unlimited quota
  google_calendar_id text,
  google_refresh_token text,          -- encrypted at rest
  created_at timestamptz default now()
)

business_hours (
  id uuid PK, business_id uuid FK not null,
  weekday int not null,               -- 0=Sunday
  opens_at time not null, closes_at time not null,
  unique (business_id, weekday)
)

services (
  id uuid PK, business_id uuid FK not null,
  name text not null,
  duration_minutes int not null,
  created_at timestamptz default now()
)

appointments (
  id uuid PK,
  business_id uuid FK not null,
  service_id uuid FK -> services not null,
  name text not null,
  phone_e164 text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,       -- derived from service duration
  status text not null default 'pending',
    -- pending | calling | confirmed | rescheduled | declined | cancelled | unreachable
  needs_attention_reason text,        -- null = clear. See below
  google_event_id text,
  created_at timestamptz default now()
)

calls (
  id uuid PK, appointment_id uuid FK not null,
  retell_call_id text unique,
  call_type text not null,            -- web | phone
  attempt int not null default 1,
  status text not null default 'queued',
    -- queued | ringing | in_progress | completed | no_answer | failed
  duration_seconds int, recording_url text, transcript text,
  disconnect_reason text,
  started_at timestamptz, ended_at timestamptz,
  created_at timestamptz default now()
)

tool_invocations (                    -- what the Agent actually DID. §8
  id uuid PK, call_id uuid FK -> calls not null,
  tool_name text not null,            -- check_availability | book_slot | cancel_appointment
  arguments jsonb not null,
  result jsonb,
  succeeded boolean not null,
  created_at timestamptz default now()
)

extractions (                          -- what the Agent SAID. §9
  id uuid PK, call_id uuid FK -> calls unique not null,
  notes text, summary text, sentiment text, in_voicemail boolean,
  confirmed boolean,                   -- fallback only, when no Tool committed
  new_time text,                       -- fallback only
  status text not null default 'ok',   -- ok | failed
  raw_llm_output text,
  created_at timestamptz default now()
)

webhook_events (
  id uuid PK, retell_call_id text, event_type text,
  payload jsonb not null, processed boolean default false,
  received_at timestamptz default now(),
  unique (retell_call_id, event_type)
)
```

**Slot uniqueness — §3 rule 8.** A plain unique index is not enough because Appointments
occupy ranges. Use a Postgres exclusion constraint:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE appointments ADD CONSTRAINT appointments_no_overlap
  EXCLUDE USING gist (
    business_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status NOT IN ('declined', 'cancelled'));
```

Drizzle will need this as raw SQL in the migration. **The concurrency test in M1 exists to
prove this constraint holds**, not to prove the application checks first.

**`needs_attention_reason`** is orthogonal to `status`, not a value of it — an Appointment
can be `confirmed` *and* collided. Non-null means Callzie will not call that person again
until a human clears it. Four reasons, all landing in the same UI surface:

| Reason | Set when |
|---|---|
| `book_failed` | `book_slot` failed after one retry (§8) |
| `collision` | Google Calendar overlap detected (ADR-0004) |
| `negotiation_truncated` | Call hit the 180s cap with no Tool committed (§7) |
| `unreachable` | Final attempt with no answer. **Slot stays held** (§14 rule 2) |

**Indexes:** `appointments(business_id, status)`, `appointments(business_id, starts_at)`,
`calls(appointment_id)`, `webhook_events(retell_call_id)`.

---

## 6. Availability

Availability is computed **entirely from Callzie's Postgres** — never from Google
(ADR-0003). This keeps `check_availability` a local query, which matters because it runs
mid-conversation and a slow response is dead air.

Given a Business and a Service: generate candidate Slots from `business_hours` in the
Business's timezone, at the Service's duration, and subtract any overlapping Appointment
that is not `declined` or `cancelled`. Never return a Slot outside Business Hours (§3
rule 6). Never return a Slot in the past.

---

## 7. Retell Integration

**Setup script `scripts/create-agent.ts`** creates one Retell LLM + Agent per Template
(four total), following the two-step Response Engine flow in `docs/verification.md` A4.

- Model: `gpt-5-nano` (cheapest tier, $0.003/min)
- `begin_message` **must be set** — an unset one triggers dynamic-opening billing
- `max_call_duration_ms: 180_000` — raised from 90s, then from 120s after a real call
  was cut off mid-booking. **This is the primary cost guardrail; enforce in config, not
  prompt.**
- `webhook_url`: `{APP_URL}/api/webhooks/retell`, `webhook_events`:
  `["call_started","call_ended","call_analyzed"]`

**Prompt shape** (per Template; this is the clinic variant — vary the persona and the
service noun, not the structure):

```
You are Maya, a friendly scheduling assistant calling on behalf of {{business_name}}.
You are speaking with {{name}} about their {{service}} on {{time}}.

Goal: confirm whether they can attend, and rebook them if they cannot.
1. Greet them by name, say why you're calling, ask if {{time}} still works.
2. If yes: call confirm_appointment, tell them it's locked in, end the call.
3. If no: call check_availability, offer the times it returns. If they reject them,
   ask what would suit and call check_availability again. Repeat until one works.
   Then call book_slot and read the booked time back to them.
4. If they want to cancel entirely: call cancel_appointment, acknowledge, end the call.
5. If it's clearly a wrong number or voicemail: apologise briefly and end the call.

Rules: keep every reply under 2 sentences. Only ever offer times that
check_availability returned — never invent one. If book_slot fails, say you'll have
someone call back to confirm; never say the booking is done. Never discuss anything
except this appointment. Never invent personal details.
```

**Tools** (Retell custom tools → Callzie API, see §9):

| Tool | Arguments | Returns |
|---|---|---|
| `check_availability` | `{ preferred_time? }` | up to 3 open Slots, in Business-local time |
| `book_slot` | `{ slot_start }` | `{ ok, booked_time }` or `{ ok: false }` |
| `confirm_appointment` | — | `{ ok }` |
| `cancel_appointment` | — | `{ ok }` |

**Offers are unlimited; exactly one Reschedule commits per Call.** The negotiation
(10am unavailable → offer 12pm → declined → 4pm → booked) is the product's best moment.
The 180s cap is the backstop, not a turn limit.

**Dynamic variables** use `{{name}}` syntax and **all values must be strings** — format
`starts_at` before sending (`docs/verification.md` A5). Unset variables render literally
to the caller, so validate before sending.

---

## 8. Tool Failure — §3 Rule 7

When `book_slot` fails — API error, or the exclusion constraint rejects because another
concurrent Call took that Slot:

1. Retry once, silently.
2. On second failure: Maya says she'll have someone call back to confirm. She **must not**
   claim the booking succeeded.
3. Set `needs_attention_reason = 'book_failed'`. The Appointment keeps its original Slot.
4. Surface it in the Needs Attention UI (§11.3) — persistent, not a toast.

`fixtures/` must include a forced `book_slot` failure so this path is tested without
spending anything.

---

## 9. Extraction — What the Agent *Said*

Tools record what the Agent **did** (`tool_invocations`). Extraction records what was
**said**, and covers what Tools cannot produce.

1. Load the transcript after `call_analyzed`.
2. Send to Claude Haiku, returning ONLY:

```json
{ "notes": "anything relevant the person said",
  "summary": "1-2 line summary",
  "sentiment": "positive | neutral | negative",
  "confirmed": null, "new_time": null }
```

3. `confirmed` and `new_time` are **fallback fields only** — populated when no Tool
   committed, so an outcome can still be reconstructed from a Call where the Agent failed
   to invoke anything. **If a Tool committed, the Tool wins.** Never overwrite a
   Tool-written outcome with an extracted one.
4. Use Retell's `call_analysis.in_voicemail` rather than making Haiku infer voicemail.
5. On parse failure: retry once with a "return only valid JSON" nudge; on second failure
   write `status = failed` with the raw output and leave the Tool-written outcome intact.

---

## 10. Testing Without Spending Money

Mandatory.

- **Availability and booking need no Calls at all.** M1 is fully testable offline,
  including the concurrency test that proves the exclusion constraint.
- **Fixtures** in `fixtures/retell/`: call started, completed-with-transcript, no-answer,
  failed, duplicate delivery, **and a failed `book_slot`**.
- **Replay script** `scripts/replay-webhook.ts` POSTs a correctly-signed fixture to the
  local webhook. Sign with a *current* timestamp — there's a 5-minute replay window.
  All webhook logic must pass via replay before any real Call.
- **Extraction tests** against 4 pasted transcripts (confirm, reschedule, decline,
  voicemail), no telephony.
- **Web Calls are the default test path** — ~$0.073/min versus ~$0.223/min to India, same
  webhooks, no KYC dependency.
- **Real Phone Calls are milestone events only** (M5, plus demo rehearsal). Budget: $10
  credit less $2/month for the number. Every Call under 180s.

---

## 11. UI & Design System

Callzie must look like a modern, venture-grade SaaS product (Linear, Resend, Cal.com
quality), not an admin template. Design is front-loaded into tokens so screens stay
consistent.

### 11.1 App shell

Persistent 240px left sidebar + main content. Items: Overview (`/`), Calls (`/calls`),
Schedule (`/schedule`), Settings (`/settings`). Collapses to icons under 1024px, drawer on
mobile. Active item gets a filled background, not just a colour change.

Sidebar footer: the **quota meter** — "3 of 5 calls used". Admin accounts show "Unlimited".
Topbar: page title left; on the right a **live indicator** (pulsing dot + "1 call in
progress") and the Clerk user button.

### 11.2 Design tokens

- **Theme:** one light theme for the app. The landing page's ink bands are the same
  tokens at dark values, scoped to a subtree — not a second theme and not a toggle.
- **Palette:** warm paper `bg`/`surface` `#FAFAF7` · `surface-soft` `#F4F3EF` ·
  `surface-card` `#ECEBE6` · hairline `line` `#E2E0DA`, `line-strong` `#C9C6BE` · ink
  `text`/`accent` `#141311`, `accent-active` `#2A2824`, `text-muted` `#6F6C64` ·
  `live` cobalt `#2445E0`, used ONLY for the pulsing dot, the in-progress status dot,
  the row shimmer and the recording playhead.
- **Status colours:** confirmed `#1F6B45`, rescheduled `#9A5B00`, declined `#B42318`,
  unreachable `#6F6C64`, **needs attention `#B4530A`**, in-progress uses `live`.
  Every one clears 4.5:1 as text on paper, because each is rendered as a word and not
  only as a dot.
- **Type:** Inter (or Geist) for UI; a mono face for phone numbers, timestamps, durations,
  Slot times, and JSON. Scale: 13px table, 14px body, 16px section titles, 22px page
  title, 32px title. No sizes outside the scale. The 32px title is the one large size:
  it carries the page title, the Call verdict and the Overview figures, and exists so
  that one thing on each screen reads first. A display serif may set it.
- **Shape:** 6px radius on cards, 4px on inputs/buttons; 1px rules over shadows, and a
  box only around an object you act inside. 4px spacing grid.
- **Motion:** 150ms ease on hover/state. One signature animation: the live pulsing dot,
  plus a shimmer on the row of the Appointment being called. Respect
  `prefers-reduced-motion`.

### 11.3 Screens

**Onboarding** — one screen, four Business Type cards. Pick one, name the Business, set a
timezone. Then straight to a **seeded dashboard**, never an empty table.

**Overview (`/`)** — the demo stage:
1. Stat strip: Total · Confirmed · **Needs attention** · Answer rate. Numbers in mono.
2. **Quick Call card** — name, phone, service, time, one accent "Call now". Accent border;
   this is the demo path.
3. **Needs Attention section, above the table, only when non-empty.** One row per reason
   with the specific problem and a Clear action. Four failure paths converge here (§5) —
   this surface is load-bearing, not a badge. Design it properly.
4. Appointments table: Name · Phone (mono) · Service · Time (mono) · Status pill ·
   Attempts · call link. Row actions: Call now. Header: Upload CSV (modal, per-row errors
   as an inline list) and Call all. In-flight rows shimmer. Revalidate every ~5s while any
   Call is live.

**Schedule (`/schedule`)** — read-only day view. Slots laid out in time, Appointments
placed, Collisions marked. **Read-only: no drag, no click-to-book.** If this starts
growing interaction, cut it — it competes with the Needs Attention surface.

**Call detail (`/calls/[id]`)** — the proof screen, two columns:
- Left: themed audio player, duration and timestamps in mono; transcript as a chat list —
  Agent turns left with an avatar dot, callee right.
- Right: **Outcome card** — what the Agent *did*, from `tool_invocations`: each Tool call
  with its arguments and result, the offered Slots, the booked time. Below it the
  Extraction card — notes, summary, sentiment — then a collapsed "Raw JSON" in mono.
  Failed extraction renders as a designed amber card with the raw output, never an
  unstyled error.
- Failed / no-answer Calls: designed states with the reason and a Retry action.

**Settings (`/settings`)** — Business Hours, Services, Business Type (changeable, no data
migration), Google Calendar connect button (flagged), quota, env status.

**Sign-in** — Clerk's component themed dark via `appearance`. Left half: the Callzie
wordmark and one line — "AI that calls your customers and rebooks them."

### 11.4 Quality floor

- Responsive to 375px (table → stacked cards).
- Visible keyboard focus rings (accent, 2px offset) on all interactive elements.
- Every async action has a loading state on its own button; never a full-page blocker.
- Toasts for transient results; **inline persistent UI for anything requiring action** —
  CSV row errors, failed extractions, everything Needs Attention.
- No lorem ipsum. Sentence case, verbs on buttons ("Call now", "Upload CSV", "Retry call").
- shadcn components restyled with the tokens above — if a screen looks like the shadcn
  default theme, it is not done.

---

## 12. Milestones

Ordered by risk, not by feature. One shippable checkpoint each.

| # | Work | Done when |
|---|---|---|
| M0 | Repo, Next.js, Clerk open signup, Postgres, full §5 schema + migrations, deploy skeleton | A stranger can create an account on the live URL |
| M1 | **Availability engine, no voice at all.** Business Hours, Services, Slot computation, the exclusion constraint | Concurrent-write tests prove double-booking is impossible. Costs nothing |
| M2 | Onboarding, four Templates, dashboard, quota meter, CSV upload, quick-add | Sign up → pick salon → seeded dashboard, quota reads 5 |
| M3 | **Agent + Tools + Web Call.** `create-agent` script, tool endpoints, web call path, dynamic variables | A browser conversation with Maya rebooks an Appointment and the row updates before hangup. **This is the product.** ~$0.15 |
| M4 | Webhooks, extraction, all four Needs Attention paths. Signature verification, idempotency, fixtures, replay script | The replay suite drives every state with zero real Calls |
| M5 | **Phone path + kill switch.** Number purchase, KYC, one real Call | A real phone rings — **or the kill switch fires, phone stays flagged off, and the product is still complete** |
| M6 | Schedule view; Google Calendar push behind a flag | A Callzie booking appears in Google; a manual overlapping event surfaces as a Collision |
| M7 | README, architecture diagram, refusal list, roadmap, demo video | All three deliverables done |

**M5 is deliberately late and deliberately isolated.** Retell KYC and India calling are the
riskiest external dependencies (`docs/verification.md` A1, A2) and neither is on the
critical path. If either fails, M6 and M7 proceed and Callzie ships complete on Web Calls.
The story becomes "voice agent platform; phone delivery is a config change" — proven, not
claimed.

Anything unfinished when M7 starts gets cut, not extended.

---

## 13. Open Verification Items

Re-check before building on them; record answers in `docs/verification.md`.

1. Whether a card is required to purchase the $2 Retell number on trial credit.
2. Which KYC path the account lands in, and how long manual review takes.
3. Whether Retell-purchased numbers can actually reach +91 — the docs contradict
   themselves (`docs/verification.md` A2). One manual dashboard call settles it.
4. ~~The exact test-user cap for a Google OAuth app in Testing status.~~ **ANSWERED** (`docs/verification.md` E1): 100 test users — and, unasked but more important, a Testing-status refresh token **expires after seven days** for any scope outside name/email/profile, which `calendar.events` is. Handled as a designed state by issue #20, not fixed.
5. Retell custom-tool schema and latency budget — how long a Tool may take before the
   Agent stalls audibly.
6. Whether `recording_url` arrives on `call_ended` or only `call_analyzed`.
7. **Whether `after()` survives on Cloud Run.** `docs/verification.md` Decision 11
   recommended `after()` over a self-POST, but that reasoning was Vercel-specific and
   ADR-0001 invalidates its premise — Cloud Run throttles CPU once the response is sent
   unless CPU-always-allocated is enabled, which can starve extraction mid-run. Either
   enable it or keep rule 3's fire-and-forget POST. **Settle before M4.**

---

## 14. What Callzie Refuses To Do

Lead with rules 2 and 4 — they show the understood risk is not the Agent doing nothing,
it's the Agent confidently doing the wrong thing.

1. **Never books outside Business Hours.** Enforced in the Tool, not the prompt.
2. **Never frees a Slot on a weak signal.** An unanswered phone is not a cancellation —
   an unreachable Appointment keeps its Slot and waits for a human.
3. **Never resolves a Collision.** It detects, blocks, and hands over.
4. **Never states that a booking succeeded when the Tool call failed.**
5. **Never lets a user author an agent prompt.** Four curated Templates, no textarea.
6. **Never places a Phone Call from an unflagged account.** Signups get Web Calls.
7. **Never accepts inbound changes from Google Calendar.** One-way push, detection only.
8. **Never discusses anything but the appointment**, and never invents personal detail.
9. **No roles, invites, or teams.** One Business, one login.

**Inbound (issue #43).** Maya answers the phone as well as placing calls. Rules 1 to 4
apply unchanged — she books through the same Tools, against the same Availability, and
behind the same exclusion constraint. These five are the ones that only exist because
the person on the line is a stranger who chose to ring:

10. **Never gives medical, safety or legal advice.** A caller who says they are in pain
    or in danger gets the Business's emergency number and nothing else. This is the
    highest-risk path in the product: an always-on clinic line receives it in week one,
    and the only acceptable answer is a real number and a hang-up. Inbound cannot be
    switched on without that number configured.
11. **Never books a Caller without a name and a reachable number.** A Slot held for
    somebody unreachable is worse than an empty Slot — it blocks a real booking and
    nobody can undo it. Enforced in the Tool, not the prompt.
12. **Never quotes a price**, and never says whether anything is covered by insurance.
13. **Never takes card or payment details**, whatever the Caller offers.
14. **Never promises a callback at a specific time.** "Someone will get back to you" is
    a promise Callzie can keep; "someone will call you at nine" is not.

Two more hold structurally rather than by instruction. An inbound Agent is never armed
with `book_slot` or `cancel_appointment`, and an outbound one is never armed with
`book_appointment` — the Tool sets are chosen by direction, and each endpoint refuses a
Call of the wrong kind. And `lookup_appointment` matches on the number the Caller is
ringing from and accepts no name, because "I'm calling about Sarah's appointment" from
an unknown number must not read a stranger's booking out loud.

---

## 15. Definition of Done

- Every milestone checkpoint in §12 passes
- Webhook replay suite passes, including the `book_slot` failure fixture
- The concurrency test proves the exclusion constraint holds
- Live URL works from a phone browser, open to signup
- README complete with architecture diagram, refusal list, and stated limitations
  (collisions detected not prevented; Google integration unverified; no DLT/TRAI position)
- Total telephony spend within free credits
- 2-minute demo video following §16 plus an architecture walkthrough

---

## 16. Demo Script

1. "Small clinics and salons lose money to no-shows. Callzie calls the customer and
   rebooks them — on the call, not afterwards." Show a dashboard with results.
2. Sign up live. Pick a Business Type. Land on the seeded dashboard.
3. "This is a real 2pm slot. Watch what happens when I say I can't make it." Place the
   Call.
4. Maya offers real open Slots. Reject one. Accept the next. She reads it back.
5. **Cut to the dashboard before hanging up** — the row has already moved. "The booking
   happened during the call, not from a transcript someone parsed afterwards."
6. Open the Call detail: the Tool invocations, the transcript, the extraction.
7. "And when it can't be sure —" show a Needs Attention row. "It stops and asks a human.
   That's the part that makes it safe to point at a real business's calendar."
