# Callzie — Primary-Source Verification

**Fetched: 2026-08-05.** Everything below is cited to a first-party source (Retell docs/SDK, Neon, Supabase, Google Cloud, Vercel, Drizzle, Anthropic, Clerk, Docker, Microsoft). Prices and free tiers move — re-check anything load-bearing before Day 1.

This file exists because SPEC.md §12 mandates it ("Record answers in `docs/verification.md` in the repo before building on them"). §12's five questions are answered first, in order, as sections **A1–A5**; the remaining Retell/LLM research is **A6–A11**; Postgres, GCP/Vercel, and local DB tooling follow as **B**, **C**, **D**. A **Watch-outs** list closes the file.

Anything not confirmable from a primary source is marked **UNVERIFIED** with a note on what would settle it.

---

## Decisions & Recommendations

| # | Decision | Recommendation | Justified in |
|---|---|---|---|
| 1 | **Can we call India (+91) on free tier?** | ✅ **RESOLVED — YES. Tested 2026-08-22.** A Retell-purchased US number (`<RETELL_TEST_FROM_NUMBER>`, `retell-twilio`) rang an Indian mobile (`<TEST_RECIPIENT_NUMBER>`). Connected, 54.4s, `disconnection_reason: inactivity` — **not** `invalid_destination`, `telephony_provider_permission_denied` or `dial_failed`. The international-calling page was current; **the outbound-debug page's "US numbers only" line is stale.** Kill switch stood down. | [A2](#a2-cost--restrictions-calling-india-91) |
| 2 | **Budget** | $10 free credit. A US→India call costs **~$0.24–0.28/min** all-in (telephony $0.15 + voice engine $0.055 + TTS $0.015 + LLM). Add the **$2/mo number**. That is ~**28–33 minutes** of India calling total. ⚠️ **Cap revised 90s → 120s** — SPEC.md §7 now lets the Agent negotiate across several Offers, and 90s truncates it. See the revised arithmetic in [A2](#a2-cost--restrictions-calling-india-91). | [A1](#a1-free-credit-card-and-phone-numbers), [A2](#a2-cost--restrictions-calling-india-91) |
| 3 | **Build the web-call path first** | ✅ **Adopted, and promoted from a test path to the product default.** Web calls cost **no telephony** (~$0.07–0.09/min vs ~$0.25) and emit **the same `call_started`/`call_ended`/`call_analyzed` webhooks**. SPEC.md §3 rule 9 now restricts Phone Calls to flagged accounts, so open signup can't drain the credit or be used to dial arbitrary numbers. | [A3](#a3-web-calls) |
| 4 | **Webhook event names** | The spec's guesses are correct as strings: **`call_started`, `call_ended`, `call_analyzed`**. Register at **agent level** via `webhook_url` on create-agent. Note `call_ended` omits `call_analysis`; treat `call_analyzed` as the source for summary/`in_voicemail`. | [A7](#a7-webhooks) |
| 5 | **Signature verification** | Header **`X-Retell-Signature`**, HMAC-SHA256 over `rawBody + timestamp`, format `v={ts},d={hex}`, keyed by your **API key** (the one flagged as webhook key). `Retell.verify()` is **async — `await` it**. 5-minute timestamp window. | [A8](#a8-signature-verification) |
| 6 | **Field name is `disconnection_reason`, not `disconnect_reason`** | The spec's §4 schema column name is fine, but the **payload key is `disconnection_reason`**. Map `dial_no_answer`/`dial_busy`/`voicemail_reached`/`user_declined` → `no_answer`; `error_*`/`invalid_destination`/`no_valid_payment` → `failed`. | [A9](#a9-transcript-recording-and-disconnection-reasons) |
| 7 | **Concurrency** | Free/PAYG workspaces get **20 concurrent calls**. §5's "max 3 concurrent" is well inside it — throttle for cost control, not for the API limit. | [A10](#a10-rate-limits--concurrency) |
| 8 | **DB driver: plain `pg`, not `@neondatabase/serverless`** | ⚠️ **Partly superseded by [ADR-0001](adr/0001-gcp-deploy-target.md)** — the `pg` + `drizzle-orm/node-postgres` recommendation still holds on Cloud SQL, but the Neon-specific pooled/direct URL split does not; Cloud SQL uses the Auth Proxy locally and the connector on Cloud Run. Original text: Neon's own Vercel guidance: "With Vercel Fluid, we recommend you use a standard Postgres TCP connection." Use `pg` + `attachDatabasePool` + `drizzle-orm/node-postgres`. **Two URLs: pooled (`-pooler`) for the app, direct for `drizzle-kit`.** | [B2](#b2-driver-choice-on-vercel--you-do-not-need-neondatabaseserverless) |
| 9 | **Stay on Neon — not Supabase, and GCP has no free Postgres at all** | ⚠️ **SUPERSEDED by [ADR-0001](adr/0001-gcp-deploy-target.md)** — Cloud SQL was chosen deliberately, with the ~$9.37/mo cost and the 90-day credit expiry accepted as known costs. Read the ADR's "Revisit if" before acting on the text below. Original: Neon scales to zero and wakes in ~hundreds of ms; **Supabase *pauses* Free projects after 1 week of inactivity and needs a human to click Resume** — the wrong failure mode for a live demo URL. Cloud SQL's cheapest real instance is ~$9.37/mo with no SLA. | [B4](#b4-alternatives--supabase-and-google-cloud) |
| 10 | **Stay on Vercel; do not switch to Cloud Run** | ⚠️ **SUPERSEDED by [ADR-0001](adr/0001-gcp-deploy-target.md)** — overruled knowingly, for GCP experience and the $300 trial credit. This row is the research recommendation, not the project's decision; the ADR is the decision. Original: SPEC.md §2 fixes the stack and §1/§14 make a live Vercel URL a deliverable. Vercel Hobby covers this app with 30×+ headroom; Cloud Run adds a Dockerfile, cold starts on the webhook path, and an `after()` CPU-throttling trap. Full tradeoff laid out rather than silently endorsed. | [C3](#c3-the-vercel-vs-cloud-run-conflict) |
| 11 | **Use `after()` instead of a self-POST** | ✅ **SETTLED by [ADR-0012](adr/0012-webhook-processes-in-after-not-a-self-post.md) — `after()`, and the Cloud Run trap does not apply.** The deploy already passes `--no-cpu-throttling` (`scripts/setup-infrastructure.sh:484`), so CPU stays allocated after the response is sent and there is nothing to starve. That flag is now load-bearing: turning it off breaks no build and fails no test, it just makes webhook processing stop halfway. `app/api/webhooks/retell/route.ts` is the first caller. Previously: 🔴 OPEN — this recommendation was Vercel-specific and [ADR-0001](adr/0001-gcp-deploy-target.md) invalidated its premise; SPEC.md §13 item 7 asked for it to be settled before M4. Original: Next 15.1's `after()` is stable and runs within the route's 300 s Hobby budget. This makes §3 rule 3's "fire-and-forget internal request" unnecessary — keep `/api/internal/extract` for manual retries, but call extraction directly. | [C3(c)](#c-does-vercel-hobby-actually-cover-this-app), [ADR-0012](adr/0012-webhook-processes-in-after-not-a-self-post.md) |
| 12 | **Local DB inspection** | ⚠️ **SUPERSEDED by [ADR-0001](adr/0001-gcp-deploy-target.md)** — there is no Neon Console. Use **`npx drizzle-kit studio`** through the Cloud SQL Auth Proxy (`bin/cloud-sql-proxy.exe`), or Cloud Console → Cloud SQL Studio. DBeaver Community if you want a desktop GUI. | [D1](#d1-inspecting-the-database-from-windows-11) |
| 13 | **Don't run local Postgres** | ⚠️ **SUPERSEDED by [ADR-0010](adr/0010-availability-steps-in-real-time-not-wall-clock.md)** — the conclusion is now reversed: the test suite *does* run a local Postgres (`embedded-postgres`, pinned to 16.14), started by `vitest.globalSetup.ts`. What changed is a requirement this row never weighed: issue #6's concurrency test has to DROP `appointments_no_overlap` to prove it is sensitive to the constraint, which is not safe against the instance backing the live URL — and #6 also requires the suite to run with no network access. "No Docker" still holds; `embedded-postgres` needs none. The Auth Proxy remains the right tool for *inspecting* the real database (decision 12), just not for running tests. Previously annotated: ⚠️ **Rationale superseded by [ADR-0001](adr/0001-gcp-deploy-target.md)**, conclusion unchanged. Neon's free branches are gone, but the Cloud SQL Auth Proxy gives you the same "no Docker" path to a real database. Still not worth running local Postgres. | [D2](#d2-is-local-postgres-worth-it), [ADR-0010](adr/0010-availability-steps-in-real-time-not-wall-clock.md) |
| 14 | **Custom-tool timeout, and dead air** | **Set `timeout_ms: 10_000` explicitly on every Tool.** Retell's default is **120,000 ms — the whole of SPEC.md §7's call cap**, so one stalled Tool would eat the entire conversation while the caller hears silence. Turn `speak_during_execution` on for `check_availability` and `book_slot`; leave `max_retry` at 0, because `book_slot` is not idempotent. | [A12](#a12-custom-tools-and-provisioning-the-four-agents-specmd-13-item-5) |
| 15 | **Four Agents, reconciled by name, ids in Postgres** | `create-agent` has no upsert and Retell does **not** enforce unique agent names. Match on `callzie-<business_type>`, update in place, and refuse to act on a duplicate. Ids live in the `retell_agents` table, not env vars — `RETELL_AGENT_ID` is dropped from SPEC.md §2's list. | [A12](#a12-custom-tools-and-provisioning-the-four-agents-specmd-13-item-5), [ADR-0006](adr/0006-agents-reconciled-against-retell.md) |

---

# A. Retell AI

Base URL `https://api.retellai.com`; auth header `Authorization: Bearer YOUR_API_KEY` ([Retell — API Reference overview](https://docs.retellai.com/api-references/overview)). Node SDK is `retell-sdk` on npm ([same](https://docs.retellai.com/api-references/overview)); latest at time of writing is **5.60.0** (npm registry `retell-sdk/latest`).

## A1. Free credit, card, and phone numbers
*(SPEC.md §12 question 1)*

**Free credit — $10.** "New accounts start with **$10 in free trial credits** so you can test Retell before adding a payment method." ([Retell — Billing overview](https://docs.retellai.com/accounts/billing)). The pricing page markets the same: "Go live in minutes with $10 in free credits" ([Retell — Pricing](https://www.retellai.com/pricing)).

**Card required?** The billing page's phrasing ("before adding a payment method") implies no card is needed to start. **UNVERIFIED:** whether a card is required specifically to *purchase a phone number* using trial credit — Retell's docs never state this. *Settled by: creating an account and attempting the $2 number purchase (Day 1, first hour).*

**⚠️ KYC gates outbound calling — this is the bigger gate than the card.** Retell requires KYC "to unlock **outbound calling, phone number purchases, and SMS** on your Retell account" ([Retell — KYC Verification](https://docs.retellai.com/accounts/kyc)). Three paths:
- **Automatic** — "automatically verified based on the information you provided during registration."
- **Persona** — "through Persona using your government-issued ID," supported in "83 countries."
- **Manual review** — "longer than the other paths"; supply "workspace id, company name, use case, and proof you represent the company."

"Each person can verify only one account" ([same](https://docs.retellai.com/accounts/kyc)). **This is a Day-1 schedule risk**: if you land in manual review, outbound calling is blocked for an unknown period. **UNVERIFIED:** turnaround time for each path, and whether an individual (non-company) can pass — the manual path's "proof you represent the company" wording suggests a business context. *Settled by: signing up and observing which path you're routed to.* If you land in manual review, invoke §13 immediately — web calls are the hedge.

**Phone numbers — you must buy one, and it's US/Canada only.** "Currently we only support purchase of US and Canada numbers" ([Retell — Purchase phone number](https://docs.retellai.com/deploy/purchase-number)). Pricing from the same page:

| Number type | Cost |
|---|---|
| US (Twilio) | **$2/month** |
| US (Telnyx) | $2/month |
| Canada | $2/month |
| US toll-free | $5/month (+ $0.06/min inbound) |

Cheapest is **$2/month for a US local number**. You can optionally specify area codes. `create-phone-call` requires `from_number` to be "a number purchased from Retell" ([Retell — Create Phone Call](https://docs.retellai.com/api-references/create-phone-call)) — though the outbound guide clarifies imported numbers work too ([Retell — Make outbound calls](https://docs.retellai.com/deploy/outbound-call)).

**Twilio import — yes, supported.** Retell supports "elastic SIP trunking or imported numbers from Twilio, Telnyx, and Vonage" ([Retell — Custom telephony](https://docs.retellai.com/deploy/custom-telephony)). Elastic SIP trunking is "the preferred method"; the setup is Twilio-side termination/origination + credentials, then `POST /import-phone-number` ([Retell — Twilio](https://docs.retellai.com/deploy/twilio), [Retell — Import Phone Number](https://docs.retellai.com/api-references/import-phone-number)). One restriction on the Dial-to-SIP-URI alternative: "you will not be able to use Retell's transfer call feature" ([Retell — Custom telephony](https://docs.retellai.com/deploy/custom-telephony)) — irrelevant to Callzie, which never transfers.

> **Verdict for Callzie:** importing a Twilio number is the escape hatch if Retell-managed numbers genuinely can't reach India (see A2), because with an imported number "International calling depends on your telephony provider's settings" ([Retell — Make outbound calls](https://docs.retellai.com/deploy/outbound-call)) — i.e. Twilio's geo-permissions, which you control. But it costs a separate Twilio account and its own balance, and blows the "free tier only" constraint.

## A2. Cost & restrictions calling India (+91)
*(SPEC.md §12 question 2 — the §11 kill-switch rides on this)*

### The per-minute number

From Retell's international-calling rate tables ([Retell — International calling](https://docs.retellai.com/deploy/international-call)), verbatim rows:

| Provider | 🇺🇸 US | 🇮🇳 **India** | 🇬🇧 UK | 🇨🇦 Canada |
|---|---|---|---|---|
| **Twilio** | $0.015 | **$0.15** | $0.10 | $0.03 |
| **Telnyx** | $0.03 | **$0.25** | — | $0.03 |

India is **10× the US telephony rate**. Full stack cost per minute of an India call, from [Retell — Pricing](https://www.retellai.com/pricing):

| Component | Rate |
|---|---|
| Telephony (Twilio → India) | $0.15/min |
| Voice infrastructure | $0.055/min |
| TTS (Retell platform voices) | $0.015/min |
| LLM (GPT-5 nano, cheapest tier) | $0.003/min |
| **Total** | **≈ $0.223/min** |

Round to **~$0.25/min** for safety. **$10 credit ÷ $0.25 = ~40 minutes**, minus $2/mo for the number → realistically **~32 minutes** of India calling.

⚠️ **Revised for the 120-second cap.** SPEC.md §7 raised `max_call_duration_ms` from 90s to 120s because the Agent now negotiates across several Offers and 90s truncates the negotiation — which would land the Appointment in `needs_attention_reason = 'negotiation_truncated'` rather than booked. The arithmetic that follows:

| | 90s (old) | **120s (current)** |
|---|---|---|
| Phone Call to India @ ~$0.25/min | ~$0.375 | **~$0.50** |
| Real Phone Calls available on ~$8 | ~21 | **~16** |
| Web Call @ ~$0.073/min | ~$0.11 | **~$0.15** |
| Accounts served at 5 Web Calls each | ~14 | **~11** |

Phone Calls are now restricted to flagged accounts (SPEC.md §3 rule 9), so the ~16 figure covers only M5 and demo rehearsal — signups draw on the Web Call line. Tight but workable if you follow SPEC.md §10 discipline.

Two billing exceptions that can inflate this ([Retell — Billing exceptions](https://docs.retellai.com/accounts/billing-exceptions)):
1. **10-second minimum** on calls using dynamic opening messages — a 3-second no-answer still bills 10s.
2. **Long-prompt scaling**: agents over **4,000 LLM tokens** get "Scaling Factor = Prompt LLM Tokens ÷ 4,000" applied to billed duration. Callzie's §7 prompt is ~200 tokens — far under. Keep it that way.

### ✅ Resolved — 2026-08-22: India is reachable

**The contradiction below is settled. A Retell-purchased number reaches +91.**

| | |
|---|---|
| From | `<RETELL_TEST_FROM_NUMBER>` — Retell-purchased, `phone_number_type: retell-twilio` |
| To | `<TEST_RECIPIENT_NUMBER>` |
| `call_id` | `<REDACTED_TEST_CALL_ID>` |
| Result | **Connected.** `call_status: ended`, `disconnection_reason: inactivity`, 54.4s |
| Recording | present · `call_analysis.in_voicemail: false` |

`inactivity` means `end_call_after_silence_ms` ended it — the call **connected and
audio flowed both ways**. None of the three blocked signals appeared.

**So the [International calling](https://docs.retellai.com/deploy/international-call)
page is current, and the [outbound-debug](https://docs.retellai.com/reliability/debug-outbound-call)
page's "numbers purchased from Retell can only make calls to US numbers" is
stale.** The reading below guessed that correctly; it is now measured rather
than guessed.

**Two things the same call also proved, at no extra cost:**

1. **Dynamic variables render correctly over telephony.** Maya opened with "Hi
   Anusha, this is Maya calling on behalf of Bandra Dental about your check-up
   appointment tomorrow at 3 pm." All four `{{...}}` values substituted — the
   literal-placeholder failure this file warns about in [A5](#a5-dynamic-variables)
   did not occur.
2. **The Agent does not invent Availability when a Tool fails.** The call carried
   no `appointment_id`, so `check_availability` had nothing to resolve and
   failed. Maya said "The check didn't go through. I'll retry with the next
   available options" and offered **no times at all**. That is SPEC.md §3 rule 7
   and §14 rule 4 holding under a real failure on a real phone line, which no
   fixture can demonstrate.

**Also settled by this purchase:** a card *was* required to buy the number —
trial credit alone did not cover it. That answers SPEC.md §13 item 1 and the
UNVERIFIED note in [A1](#a1-free-credit-card-and-phone-numbers). KYC cleared
without manual review.

**Still unverified, and unchanged by this test:** the DLT/TRAI position below.
One consented call to the builder's own phone says nothing about commercial
outbound campaigns into India.

### ⚠️ Found — 2026-08-25: the line works, the conversation does not

Follow-up calls on the same route surfaced two defects, both fixed with
per-call `agent_override` on `create-phone-call` (see `PHONE_AGENT_OVERRIDE`
in `lib/calls/start-call.ts`):

1. **Maya could not understand the caller.** The Agents transcribe `en-US`
   (`scripts/create-agent.ts`), and on a compressed US→India line that misheard
   Indian-accented English badly enough that Retell recorded the caller as
   *silent* — the 2026-08-22 call's `disconnection_reason: inactivity` at 54.4s
   was this, not an actually quiet caller. Phone Calls now override to
   `language: en-IN` and `stt_mode: accurate`.

2. **Maya sometimes started talking before the person picked up.** The carrier
   can signal "answered" seconds before a human is listening. The 1500ms
   `begin_message_delay_ms` patch only moved the gap; the fix is
   `start_speaker: "user"` — wait for an actual hello — with
   `begin_after_user_silence_ms: 10000` so a mute pickup still gets a greeting
   instead of burning the 120-second cap in silence (the inactivity timer only
   runs after agent speech). The delay is scrubbed from the Agents (explicit
   `begin_message_delay_ms: 0`); Web Calls keep the instant scripted opening.

**Verified the same day, end-to-end** (`<REDACTED_TEST_CALL_ID>`,
placed through `startCall` against a real Appointment). A screening service
answered first and Maya waited through it rather than talking over it; the
caller's Indian English transcribed cleanly; and `check_availability` succeeded
twice (216ms, 36ms) with Maya offering exactly the returned slots — so the
"response error" on an earlier ad-hoc call was only the missing `calls` row,
not a Tool defect (Tools resolve `call.call_id → calls.retell_call_id`, so a
call placed around `startCall` has no identity and every Tool refuses).

**Known limit, then fixed:** that call ended `max_duration_reached` at exactly
120s, mid-booking, and the Appointment was correctly flagged
`negotiation_truncated`. The screener ate the first ~40 seconds. The cap is
SPEC.md §7's cost guardrail, so raising it was a spec decision — taken the same
day: **the cap is now 180s** (§7 updated, all four Agents re-provisioned).

**The recall closed the loop** (`<REDACTED_TEST_CALL_ID>`, attempt 3
on the same Appointment, after the human-clears-it step). Screener again,
waited through it again; two `check_availability` calls (28ms, 26ms) and one
`book_slot` — the Appointment moved to `rescheduled` at the agreed 11:40 AM
IST, the call ended naturally at 80.8s, and the webhook wrote `completed`.
Every stage of SPEC.md §7's negotiation has now run on a real phone line.

### ⚠️ The blocking contradiction (superseded by the resolution above)

**Retell's own documentation contradicts itself on whether a Retell-purchased number can call India at all.** Both quotes are verbatim from docs.retellai.com, fetched 2026-08-05:

> "You can use Retell-managed numbers to call US and international destinations. The tables below list the supported countries and their per-minute rates. … For example, a US-based support team can use a Retell number to reach customers in **India**, the UK, and Australia without a local provider in each country."
> — [Retell — International calling](https://docs.retellai.com/deploy/international-call)

> "If using numbers purchased from Retell → Make sure the destination number can accept the call. **Currently, numbers purchased from Retell can only make calls to US numbers.**"
> — [Retell — Debug outbound connection issues](https://docs.retellai.com/reliability/debug-outbound-call)

These cannot both be true. The outbound-calling guide adds a third data point that leans toward *supported*: "Retell-purchased numbers: Retell supports calling to [15 countries]" ([Retell — Make outbound calls](https://docs.retellai.com/deploy/outbound-call)) — and India is one of the 15 in the Twilio table.

**Reading:** the international-calling page is more specific, more recently structured, and quotes a concrete India rate, so it is probably current; the debug page's line is probably stale. But "probably" is not what a kill switch runs on.

**→ Day 1, first hour, before writing any code: place one manual dashboard call from a Retell US number to your own +91 mobile.** That single call costs ~$0.25 and definitively resolves the §11 kill switch. Watch for `disconnection_reason` values `invalid_destination`, `telephony_provider_permission_denied`, or `dial_failed` — any of those means blocked.

### KYC / DLT / TRAI / regulatory

**UNVERIFIED — and this is a genuine gap, not an oversight.** Retell's compliance page covers HIPAA ("A signed BAA is required before transmitting PHI"), GDPR ("via AWS infrastructure with a GDPR-compliant Data Processing Addendum"), and "SOC 2 Type 1 and Type 2" ([Retell — Security and compliance](https://docs.retellai.com/general/compliance)). It contains **no mention of TCPA, robocall/telemarketing rules, consent requirements, or any country-specific calling obligation** placed on the customer. Searching Retell's docs for TRAI/DLT returns nothing first-party.

What this means concretely:
- **Retell does not claim** DLT registration or TRAI compliance for calls terminating in India.
- India's DLT framework governs *commercial* messaging/calling from Indian sender IDs. A US-origin international call to an Indian mobile is a different regulatory path — **UNVERIFIED whether DLT registration applies.**
- *Settled by:* emailing support@retellai.com, or consulting Indian telecom counsel. **Neither is in scope for a 5-day portfolio build.**

**Practical guidance for the build:** you are calling **your own phone and consenting friends' phones**, in a demo, a handful of times. That is materially different from a commercial outbound campaign. Do not generalize this into a claim that Callzie is production-legal in India — say so explicitly in the README, and treat "compliance is a real, unsolved problem for this market" as a talking point rather than a hidden risk.

**Also relevant:** Retell's fraud-protection tooling exists precisely because international calling attracts abuse — "rate limiting by IP and destination number, geographic restrictions" ([Retell — Fraud Protection](https://docs.retellai.com/reliability/fraud-protection)). If an India call fails, check whether a geographic restriction is on by default.

## A3. Web calls
*(SPEC.md §12 question 5 — the §13 fallback)*

**Available: yes.** `POST https://api.retellai.com/v2/create-web-call` ([Retell — Create Web Call](https://docs.retellai.com/api-references/create-web-call)).

**Required field:** `agent_id` only. **Optional:** `retell_llm_dynamic_variables` — "Add optional dynamic variables in key value pairs of string that injects into your Response Engine prompt and tool description" — plus `metadata`, `current_node_id`, `current_state`.

**Response (201)** returns `access_token` ("Access token to enter the web call room. This needs to be passed to your frontend to join the call") and `call_id` ("Unique id of the call"). `call_type` is `"web_call"`.

**Cost: no telephony charge.** "audio streams over the internet through the Retell Web SDK, so there is **no telephony setup or per-minute telephony cost**" ([Retell — Make a web call](https://docs.retellai.com/deploy/web-call)). You still pay voice infra + TTS + LLM: **~$0.073/min** vs ~$0.223/min for India. **That is a 3× cost reduction per test minute.**

**Same webhooks: yes.** Web calls trigger "call_started, call_ended, and call_analyzed events" ([Retell — Make a web call](https://docs.retellai.com/deploy/web-call)). The identical envelope and `call` object apply; only `call_type` differs (`"web_call"` vs `"phone_call"`).

**Frontend, verbatim from the docs:**

```bash
npm install retell-client-js-sdk
```

```javascript
import { RetellWebClient } from "retell-client-js-sdk";
const retellWebClient = new RetellWebClient();
async function startCall() {
  const response = await fetch("/api/create-web-call", { method: "POST" });
  const { accessToken } = await response.json();
  await retellWebClient.startCall({ accessToken });
}
```

**Gotcha:** "Start the call within **30 seconds** of creating it. After that, the access token is invalidated" ([same](https://docs.retellai.com/deploy/web-call)). A user who doesn't grant mic permission in time produces `disconnection_reason: "error_user_not_joined"` ("User did not join web call within 30 seconds of startWebCall" — [Retell — Debug call disconnection](https://docs.retellai.com/reliability/debug-call-disconnect)).

> **Strong recommendation (Decision 3):** do not treat web calls as a Day-2 contingency. Build them on Day 1 as the *test harness*. Every webhook, signature, status-mapping and extraction test runs on web calls at 1/3 the cost with zero telephony/KYC dependency. Phone delivery then becomes swapping `create-web-call` for `create-phone-call` — which is exactly the "phone delivery is a config change" story §13 wants to tell, except you'll have proven it rather than claimed it.

## A4. Agent creation via API (the two-step Response Engine flow)

Retell separates the **Response Engine** (the brain) from the **Agent** (voice + telephony + webhook config). You create the engine first, then the agent that points at it.

### Step 1 — Create the Retell LLM

`POST https://api.retellai.com/create-retell-llm` ([Retell — Create Retell LLM](https://docs.retellai.com/api-references/create-retell-llm)). Key fields:
- `general_prompt` — "General prompt appended to system prompt no matter what state the agent is in."
- `begin_message` — "First utterance said by the agent in the call. If not set, LLM will dynamically generate a message." **Set this** — an unset `begin_message` means a dynamic opening, which triggers the 10-second billing minimum (A2).
- `model` — if omitted, "the Retell LLM uses the endpoint's default text model" ([Retell — Create voice agent with TypeScript SDK](https://docs.retellai.com/get-started/create-agent-with-sdk)).
- `general_tools` — e.g. `{ type: "end_call", name: "end_call", description: "..." }`.

**Allowed `model` values** (enumerated verbatim from the API reference): `gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano`, `gpt-5`, `gpt-5-mini`, **`gpt-5-nano`**, `gpt-5.1`, `gpt-5.2`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.5`, `gpt-5.6-terra`, `gpt-5.6-luna`, `claude-4.5-sonnet`, `claude-4.6-sonnet`, `claude-5-sonnet`, `claude-4.5-haiku`, `gemini-3.0-flash`, `gemini-3.1-flash-lite`, `gemini-3.5-flash`. Speech-to-speech: `gpt-realtime-2.1`, `gpt-realtime-2.1-mini`, `gpt-realtime-2`, `gpt-realtime-1.5`, `gpt-realtime`, `gpt-realtime-mini`.

**Cheapest tier: `gpt-5-nano` at $0.003/min** — the lowest LLM rate on the pricing page ([Retell — Pricing](https://www.retellai.com/pricing)), where the range runs "$0.003/min (GPT 5 nano) to $0.16/min (GPT 5.5)". Use it. SPEC.md §7 says "cheapest available model tier" — this is it.

### Step 2 — Create the Agent

`POST https://api.retellai.com/create-agent` ([Retell — Create Voice Agent](https://docs.retellai.com/api-references/create-agent)). **Required: `response_engine` and `voice_id`.**

`response_engine` accepts three shapes:
```json
{ "type": "retell-llm",         "llm_id": "llm_...",           "version": 0 }
{ "type": "custom-llm",         "llm_websocket_url": "wss://..." }
{ "type": "conversation-flow",  "conversation_flow_id": "...", "version": 0 }
```

Webhook fields on the agent: `webhook_url` ("Optional endpoint for call events; set to `null` to remove"), `webhook_events` (array, **default `["call_started","call_ended","call_analyzed"]`**), `webhook_timeout_ms` (default `10000`).

### Concrete, current-shaped payload for `scripts/create-agent.ts`

```ts
import Retell from "retell-sdk";

const client = new Retell({ apiKey: process.env.RETELL_API_KEY! });

// --- Step 1: the Response Engine -------------------------------------------
const llm = await client.llm.create({
  model: "gpt-5-nano",              // cheapest tier: $0.003/min
  start_speaker: "agent",
  begin_message:
    "Hi, this is Maya calling from the clinic about your appointment.",
  general_prompt: `You are Maya, a friendly scheduling assistant calling on behalf of a clinic.
You are speaking with {{name}} about their appointment on {{time}}.

Goal: confirm whether they can attend.
1. Greet them by name, say why you're calling, ask if {{time}} still works.
2. If yes: thank them, confirm it's locked in, end the call.
3. If no: ask what day and time works better, repeat it back to confirm, end the call.
4. If they want to cancel entirely: acknowledge politely, end the call.
5. If it's clearly a wrong number or voicemail: apologize briefly and end the call.

Rules: keep every reply under 2 sentences. Never discuss anything except this
appointment. Never invent medical or personal details. End the call within 90 seconds.`,
  general_tools: [
    {
      type: "end_call",
      name: "end_call",
      description:
        "End the call once the appointment is confirmed, rescheduled, declined, or voicemail is reached.",
    },
  ],
});

// --- Step 2: the Agent ------------------------------------------------------
const agent = await client.agent.create({
  agent_name: "Callzie — appointment confirmation",
  response_engine: { type: "retell-llm", llm_id: llm.llm_id },
  voice_id: "11labs-Adrian",                       // any Retell platform voice
  language: "en-US",
  webhook_url: `${process.env.APP_URL}/api/webhooks/retell`,
  webhook_events: ["call_started", "call_ended", "call_analyzed"],
  max_call_duration_ms: 120_000,                   // hard cap — protects the $10
  end_call_after_silence_ms: 15_000,
});

console.log({ llm_id: llm.llm_id, agent_id: agent.agent_id });
```

Response shape from create-agent (verbatim example): `agent_id`, `version`, `is_published`, `response_engine`, `voice_id`, `agent_name`, `last_modification_timestamp`.

**Publishing:** "Publish it from the dashboard version panel or call the publish agent API with the `agent_id` and `version` printed by the script. Published versions cannot be modified after creation." ([Retell — Create voice agent with TypeScript SDK](https://docs.retellai.com/get-started/create-agent-with-sdk)).

> **`max_call_duration_ms` is your single most important cost guardrail.** SPEC.md §9 says "every real call under 2 minutes" — enforce it in config, not in the prompt. A prompt instruction is a suggestion; `max_call_duration_ms` is a hard stop (it produces `disconnection_reason: "max_duration_reached"`).

⚠️ **This sample is illustrative and predates SPEC.md §7.** Two things in it are superseded, and the implementation in `scripts/create-agent.ts` is what ships:
- **`max_call_duration_ms` is 120,000, not 90,000** — §7 raised it because the Agent now negotiates across several Offers (see also A2's revision note). Corrected inline above.
- **The prompt shown here has no Tools** and instructs "End the call within 90 seconds". SPEC.md §7's prompt calls `check_availability` / `book_slot` / `confirm_appointment` / `cancel_appointment` (ADR-0003) and states **no** time limit — the cap belongs in config, which is the whole point of the paragraph above. Tool declarations are in **A12**.
- One Agent is shown; Callzie provisions **four**, one per Template (SPEC.md §4), named `callzie-<business_type>`. See A12 and ADR-0006.

## A5. Dynamic variables
*(SPEC.md §12 question 4)*

**Syntax: `{{name}}` — the spec's guess is correct.** "Dynamic variables are placeholders surrounded by **double curly braces**", e.g. `"Hello {{user_name}}, thanks for calling!"` ([Retell — Dynamic variables](https://docs.retellai.com/build/dynamic-variables)).

**Request field: `retell_llm_dynamic_variables`.** "When using the Create Phone Call API, set your variables in the `retell_llm_dynamic_variables` field" ([same](https://docs.retellai.com/build/dynamic-variables)). Same field name on `create-web-call` and on each task in `create-batch-call`.

**⚠️ Hard constraint: "All values in `retell_llm_dynamic_variables` must be strings."** ([same](https://docs.retellai.com/build/dynamic-variables)). Callzie's `scheduled_at` is a `timestamptz` — you **must** format it to a human string before sending. Passing a Date or a number will fail.

**Reserved / built-in variables** (do not shadow these) ([same](https://docs.retellai.com/build/dynamic-variables)):

| Category | Variables |
|---|---|
| Time | `{{current_time}}`, `{{current_time_[timezone]}}` (e.g. `{{current_time_Asia/Kolkata}}`), `{{current_hour}}`, `{{current_hour_[timezone]}}`, `{{current_calendar}}`, `{{current_calendar_[timezone]}}` |
| Session | `{{session_type}}`, `{{session_duration}}`, `{{session_duration_ms}}` |
| State | `{{current_agent_state}}`, `{{previous_agent_state}}`, `{{current_node}}`, `{{previous_node}}` |
| Phone | `{{direction}}`, `{{user_number}}`, `{{agent_number}}`, `{{call_id}}`, `{{call_type}}` |
| Chat | `{{chat_id}}` |
| Contacts | `{{first_name}}`, `{{last_name}}`, `{{do_not_call}}` + custom fields (auto-populated on contact match) |

Callzie's `{{name}}` and `{{time}}` do **not** collide with any reserved name. ⚠️ But note `{{first_name}}` **is** reserved and auto-populates from Retell Contacts — avoid it.

**Unset-variable behavior:** "Unset variables remain literal" — `{{user_name}}` renders as the literal text `{{user_name}}` to the caller. **This is a demo-breaking failure mode**: a bug in your variable plumbing means Maya literally says "Hello curly-curly-name". Validate before sending. Empty strings replace with nothing; omitting a key or passing `null` falls back to agent-level defaults ([same](https://docs.retellai.com/build/dynamic-variables)).

## A6. create-phone-call

`POST https://api.retellai.com/v2/create-phone-call` ([Retell — Create Phone Call](https://docs.retellai.com/api-references/create-phone-call)). Note the **`/v2/`** prefix — create-agent and create-retell-llm are unversioned, this one is not.

**Required:**
- `from_number` — "The number you own in E.164 format. Must be a number purchased from Retell"
- `to_number` — "The number you want to call, in E.164 format"

**Optional:** `override_agent_id`, `override_agent_version`, `agent_override`, `metadata` ("An arbitrary object for storage purpose only"), `retell_llm_dynamic_variables`, `custom_sip_headers`, `ignore_e164_validation`.

**Response: HTTP 201**, a `V2PhoneCallResponse`. **The call id is the top-level `call_id`** — "Unique id of the call. Used to identify the call in the LLM websocket." Also returned: `call_type: "phone_call"`, `from_number`, `to_number`, `direction`, `agent_id`, `agent_name`, `agent_version`, `call_status` (one of `registered`, `not_connected`, `ongoing`, `ended`, `error`), and echoes of `metadata` / `retell_llm_dynamic_variables`.

**Example request (verbatim from docs):**
```json
{
  "from_number": "+14157774444",
  "to_number": "+12137774445",
  "retell_llm_dynamic_variables": { "customer_name": "John Doe" }
}
```

**For Callzie's `/api/appointments/[id]/call`:**
```ts
const call = await client.call.createPhoneCall({
  from_number: process.env.RETELL_FROM_NUMBER!,        // your $2 US number
  to_number: appointment.phone_e164,                    // +91... (see A2)
  // Four Agents exist, one per Business Type — resolve the right one. There is
  // no RETELL_AGENT_ID env var; see A12 and ADR-0006.
  override_agent_id: await agentIdFor(business.businessType),
  retell_llm_dynamic_variables: {
    business_name: business.name,                       // string
    name: appointment.name,                             // string
    service: service.name,                              // string
    time: formatAppointmentTime(appointment.scheduled_at), // MUST be a string
  },
  metadata: { appointment_id: appointment.id, attempt: String(attempt) },
});
// store call.call_id in calls.retell_call_id
```

> **Use `metadata` for your own IDs.** It's echoed back on every webhook payload, which means your webhook handler can recover the appointment even if the DB write raced the `call_started` event. Cheap insurance against §6's ordering assumptions.

**Batch calls** are also available — `POST /create-batch-call` with `from_number` + a `tasks` array (each `{ to_number, retell_llm_dynamic_variables, metadata, ... }`), optional `trigger_timestamp` (Unix ms; "If omitted, the call will be sent immediately"), and `reserved_concurrency` to hold back capacity for non-batch calls ([Retell — Create Batch Call](https://docs.retellai.com/api-references/create-batch-call)). **Do not use this for §5's Call All** — it doesn't give you the per-call `call_id` mapping the spec's data model needs, and its `reserved_concurrency` is manual, not automatic throttling. Loop with a concurrency limiter instead.

## A7. Webhooks
*(SPEC.md §12 question 3, part 1)*

### Exact event names — the spec's guesses are correct

Voice: **`call_started`**, **`call_ended`**, **`call_analyzed`**, `transcript_updated`, `transfer_started`, `transfer_bridged`, `transfer_cancelled`, `transfer_ended`. Chat: `chat_started`, `chat_ended`, `chat_analyzed`. ([Retell — Webhooks overview](https://docs.retellai.com/features/webhook-overview))

Callzie needs only the first three — which is also the `webhook_events` default on create-agent.

### Envelope

Every payload is the same two-key shape ([Retell — Register and set up a webhook](https://docs.retellai.com/features/register-webhook)):

```json
{ "event": "string", "call": { } }
```

### Payload contents per event

| Event | Contains | Triggered when |
|---|---|---|
| `call_started` | "Basic call information" | Call begins |
| `call_ended` | **"All fields from the call object except `call_analysis`"** | "a call completes, transfers, or encounters an error" |
| `call_analyzed` | "Full call data including `call_analysis` object" | "call analysis is complete" |
| `transcript_updated` | Full call data plus `transcript_with_tool_calls` | Live, during the call |

([Retell — Webhooks overview](https://docs.retellai.com/features/webhook-overview))

**Full `call_ended` example, verbatim from the docs:**

```json
{
  "event": "call_ended",
  "call": {
    "call_type": "phone_call",
    "from_number": "+12137771234",
    "to_number": "+12137771235",
    "direction": "inbound",
    "call_id": "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6",
    "agent_id": "oBeDLoLOeuAbiuaMFXRtDOLriTJ5tSxD",
    "call_status": "registered",
    "metadata": {},
    "retell_llm_dynamic_variables": { "customer_name": "John Doe" },
    "start_timestamp": 1714608475945,
    "end_timestamp": 1714608491736,
    "disconnection_reason": "user_hangup",
    "transcript": "...",
    "opt_out_sensitive_data_storage": false
  }
}
```

Use this as the base for `fixtures/retell/` per §9. Timestamps are **Unix milliseconds**.

### Where the webhook URL is configured — and why it matters

Two levels ([Retell — Register and set up a webhook](https://docs.retellai.com/features/register-webhook)):
- **Account-level** — dashboard Webhooks tab; "notify you of events related to any agent under your account."
- **Agent-level** — the `webhook_url` field on create/update-agent; "Any event associated with that agent will be pushed to the agent webhooks URL."

**⚠️ It matters: "if set, account-level webhooks won't trigger for that agent."** Agent-level *overrides*, it does not stack. SPEC.md §7 says webhook URL is "configured on the agent" — correct, and that means the account-level webhook (if you set one during dashboard testing) goes silent for this agent. Don't debug a "missing webhook" for an hour because of this.

### Delivery, retries, timeout

"The webhook has a **timeout of 10 seconds**. If within 10 seconds no success status (2xx) is received, the webhook will be **retried, up to 3 times**." ([Retell — Webhooks](https://docs.retellai.com/features/webhook))

This is exactly why SPEC.md §3 rule 2 (idempotency) and rule 3 (return 200 fast) exist. Retries are real and will hit you. `webhook_timeout_ms` is configurable on the agent (default `10000`).

Ordering: "webhooks are triggered in order, but is not blocking" ([Retell — Webhooks overview](https://docs.retellai.com/features/webhook-overview)) — so `call_ended` fires before `call_analyzed`, but the delay between them is **UNVERIFIED** (docs give no window). *Settled by: timing a real call.* Design §6 to not depend on it.

## A8. Signature verification
*(SPEC.md §12 question 3, part 2 — and §3 hard rule 4)*

**Header: `X-Retell-Signature`** ([Retell — Secure the webhook](https://docs.retellai.com/features/secure-webhook)).

**Scheme: HMAC-SHA256, format `v={timestamp},d={hex_digest}`, signed over `rawBody + timestamp`, keyed by your API key.** This is confirmed not just from docs but from the SDK source itself (`retell-sdk@5.60.0`, `src/lib/webhook_auth.ts`) — the authoritative version:

```ts
const FIVE_MINUTES = 5 * 60 * 1000;

async sign(input: string, secret: string, timestamp: number = Date.now()): Promise<string> {
  const digest = await hmacSha256Hex(secret, input + timestamp);   // note: input CONCAT timestamp
  return `v=${timestamp},d=${digest}`;
}

async verify(input, secret, signature, opts = {}): Promise<boolean> {
  const match = /^v=(\d+),d=([0-9a-f]+)$/i.exec(signature);
  if (!match) return false;
  const poststamp = Number(match[1]);
  const timeout = opts.timeout ?? FIVE_MINUTES;
  if (Math.abs(Date.now() - poststamp) > timeout) return false;    // 5-min replay window
  return hmacSha256Verify(secret, input + poststamp, postDigest);
}

/** Verify a Retell webhook signature against the exact raw request body. */
export const verify = (body: string, apiKey: string, signature: string): Promise<boolean> =>
  symmetric.verify(body, apiKey, signature);
```

**Four things that will bite you, in order of likelihood:**

1. **`Retell.verify()` is `async` and returns `Promise<boolean>`.** Older examples online call it synchronously. `if (!Retell.verify(...))` is always falsy-negated (a Promise is truthy) — **your handler would accept every payload, including forged ones.** You must `await`.
2. **You must use the raw body.** "You must use the **raw request body** string for verification, not a re-serialized version from parsed JSON" ([Retell — Secure the webhook](https://docs.retellai.com/features/secure-webhook)). In Next.js 15 App Router: `await request.text()`, then `JSON.parse` it yourself. Never `await request.json()` first.
3. **The secret is the API key, not a separate secret.** Docs: "Your Retell API Key (the one with a webhook badge)." You designate it in the dashboard: "Select an existing API key, Click 'Set as Webhook Key' to designate it for webhook authentication… Only one key can be set as the webhook key at a time" ([Retell — Manage API keys](https://docs.retellai.com/accounts/manage-api-keys)). ⚠️ **SPEC.md §2 defines `RETELL_WEBHOOK_SECRET` as a separate env var — it will hold the same value as `RETELL_API_KEY`.** Keep both names for clarity, but know they're the same string.
4. **5-minute replay window.** Your `scripts/replay-webhook.ts` (§9) must sign with a *current* timestamp, not one baked into the fixture. Use the SDK's exported `sign()` — it's the exact counterpart of `verify()`.

**Official Node example (verbatim from the docs, Express flavor):**

```typescript
import { Retell } from "retell-sdk";
import express from "express";

const app = express();
app.use(express.raw({ type: "application/json" }));

app.post("/webhook", async (req, res) => {
  const rawBody = req.body.toString("utf-8");
  const signature = req.headers["x-retell-signature"];

  if (
    typeof signature !== "string" ||
    !(await Retell.verify(rawBody, process.env.RETELL_API_KEY, signature))
  ) {
    console.error("Invalid signature");
    return res.status(401).send("Unauthorized");
  }

  const { event, call } = JSON.parse(rawBody);
  // process the webhook
  res.status(204).send();
});
```

**Next.js 15 App Router adaptation for `/api/webhooks/retell`:**

```ts
import { Retell } from "retell-sdk";
import { after } from "next/server";

export async function POST(request: Request) {
  const rawBody = await request.text();                     // RAW — never .json() first
  const signature = request.headers.get("x-retell-signature");

  if (!signature || !(await Retell.verify(rawBody, process.env.RETELL_API_KEY!, signature))) {
    return new Response("Unauthorized", { status: 401 });    // §3 rule 4
  }

  const { event, call } = JSON.parse(rawBody);

  // §3 rule 3: persist raw first, return 200 fast.
  await persistWebhookEvent(call.call_id, event, JSON.parse(rawBody));

  after(async () => { await processEvent(event, call); });   // §3 rule 3 fire-and-forget
  return new Response(null, { status: 200 });
}
```

**IP allowlist (defence in depth, optional):** Retell publishes a single source IP, `100.20.5.228` ([Retell — Secure the webhook](https://docs.retellai.com/features/secure-webhook)). Signature verification is the primary control; don't rely on IP alone (Vercel sits behind a proxy anyway).

## A9. Transcript, recording, and disconnection reasons
*(SPEC.md §6's status mapping depends on this enumeration)*

### Which event carries what

| Field | `call_started` | `call_ended` | `call_analyzed` |
|---|:---:|:---:|:---:|
| `transcript`, `transcript_object` | — | ✅ | ✅ |
| `disconnection_reason` | — | ✅ | ✅ |
| `duration_ms`, `start_timestamp`, `end_timestamp` | partial | ✅ | ✅ |
| `recording_url` | — | ❓ | ✅ |
| `call_analysis` | — | ❌ **explicitly excluded** | ✅ |

Sources: [Retell — Webhooks overview](https://docs.retellai.com/features/webhook-overview) (`call_ended` = "All fields from the call object except `call_analysis`"), [Retell — Get Call](https://docs.retellai.com/api-references/get-call).

**`recording_url` timing is UNVERIFIED.** Neither the webhook-overview page nor the post-call-analysis page states which event first carries it ([Retell — Consume the analysis data](https://docs.retellai.com/features/post-call-analysis-consumption) explicitly does not specify). Recording upload plausibly completes after `call_ended`. *Settled by: logging both payloads on the first real call.* **Design defensively:** upsert `recording_url` on both `call_ended` and `call_analyzed`, taking whichever is non-null. SPEC.md §6 step 3 already hints at this pattern for the transcript — apply it to `recording_url` too.

**`call_analysis` sub-fields** ([Retell — Get Call](https://docs.retellai.com/api-references/get-call)): `call_summary`, `in_voicemail`, `user_sentiment`, `call_successful`, `custom_analysis_data`.

> **Note for §8:** Retell's own `call_analysis.call_summary` overlaps with what Claude Haiku produces. Keep the Haiku extraction — it's the point of the project and produces the structured `confirmed`/`new_time` fields Retell won't. But `in_voicemail` is a **free, reliable voicemail signal** — use it to short-circuit extraction rather than making Haiku infer voicemail from a transcript. Caveat: "We will not populate custom post-call analysis fields for calls that were not connected or where no conversation took place" ([Retell — Consume the analysis data](https://docs.retellai.com/features/post-call-analysis-consumption)).

### ⚠️ The field is `disconnection_reason` (not `disconnect_reason`)

"The exact field name is **`disconnection_reason`**" ([Retell — Debug call disconnection](https://docs.retellai.com/reliability/debug-call-disconnect)). SPEC.md §4's DB column is named `disconnect_reason` — that's fine as a column name, but **read `payload.call.disconnection_reason`**. Getting this wrong yields silent `undefined` and every call mapping to `failed`.

### Complete enumeration, with Retell's own `call_status` grouping

Verbatim from [Retell — Debug call disconnection](https://docs.retellai.com/reliability/debug-call-disconnect) and [Retell — Get Call](https://docs.retellai.com/api-references/get-call):

| `disconnection_reason` | Retell `call_status` | Meaning | **→ Callzie `calls.status`** |
|---|---|---|---|
| `user_hangup` | ended | "Expected behavior, user hung up the call." | `completed` |
| `agent_hangup` | ended | "Expected behavior, agent hung up the call." | `completed` |
| `call_transfer` | ended | Agent transferred the call | `completed` |
| `call_take_over` | ended | Human assumed control | `completed` |
| `max_duration_reached` | ended | "Call was terminated due to maximum duration reached." | `completed` |
| `inactivity` | ended | Terminated via `end_call_after_silence_ms` | `completed` |
| **`voicemail_reached`** | ended | Voicemail encountered | **`no_answer`** |
| **`ivr_reached`** | ended | IVR encountered | **`no_answer`** |
| **`dial_no_answer`** | not_connected | "The number dialed did not answer." | **`no_answer`** |
| **`dial_busy`** | not_connected | "The number dialed is busy." | **`no_answer`** |
| **`user_declined`** | not_connected | "User declined the call." | **`no_answer`** |
| `dial_failed` | not_connected | "Dialing failed with no or unknown sip error code." | `failed` |
| **`invalid_destination`** | not_connected | Invalid format/characters; may require E.164 | `failed` **← India-block signal** |
| **`telephony_provider_permission_denied`** | not_connected | "SIP trunk credentials are not authenticated." | `failed` **← India-block signal** |
| `telephony_provider_unavailable` | not_connected | Provider unavailable | `failed` |
| `sip_routing_error` | not_connected | Too many hops / loop | `failed` |
| `marked_as_spam` | not_connected | "Number dialed is marked as spam." | `failed` |
| `concurrency_limit_reached` | error | Limit exceeded; "retry with exponential backoff recommended" | `failed` |
| `no_concurrency_fallback` | ended | Inbound transferred to fallback | `failed` |
| **`no_valid_payment`** | error | "No valid payment or service shut down due to overdue billing" | `failed` **← credit exhausted** |
| `scam_detected` | error | Scam detected for that agent | `failed` |
| `error_llm_websocket_open` / `_lost_connection` / `_runtime` / `_corrupt_payload` | error | Custom-LLM websocket faults (N/A — we use retell-llm) | `failed` |
| `error_no_audio_received` | error | No audio from Twilio or web frontend | `failed` |
| `error_asr` | error | "Retell's ASR encountered a problem." | `failed` |
| `error_retell` | error | "Unspecified Retell side problem." | `failed` |
| `error_unknown` | error | "Unknown error." | `failed` |
| **`error_user_not_joined`** | error | User didn't join web call within 30s | `failed` **← web-call only** |
| `registered_call_timeout` | error | "Phone call is 5 minutes or more apart from registration." | `failed` |
| `transfer_bridged` / `transfer_cancelled` | ended | Transfer outcomes (N/A) | `completed` / `failed` |
| `manual_stopped` | ended | Stopped manually | `failed` |

**Concrete mapping function for §6:**

```ts
const NO_ANSWER = new Set([
  "dial_no_answer", "dial_busy", "user_declined",
  "voicemail_reached", "ivr_reached",
]);
const COMPLETED = new Set([
  "user_hangup", "agent_hangup", "call_transfer", "call_take_over",
  "max_duration_reached", "inactivity", "transfer_bridged",
]);

export function mapCallStatus(reason: string | null | undefined) {
  if (!reason) return "failed";
  if (COMPLETED.has(reason)) return "completed";
  if (NO_ANSWER.has(reason)) return "no_answer";
  return "failed";                     // everything else, incl. all error_*
}
```

**Distinguishing no-answer / voicemail / busy / error — answered:**
- **No answer** → `dial_no_answer` (also `call_status: "not_connected"`, and `transcript` will be empty)
- **Voicemail** → `voicemail_reached`, *and* `call_analysis.in_voicemail === true` on `call_analyzed`. Note `call_status` is `ended` here, not `not_connected` — a status-only check would misclassify voicemail as a completed call.
- **Busy** → `dial_busy`
- **Error** → any `error_*`, plus `invalid_destination`, `no_valid_payment`, `sip_routing_error`, `marked_as_spam`

> **Two reasons deserve alerting in the UI, not silent `failed`:** `no_valid_payment` means **the $10 credit is gone** — the demo is over until you top up. `concurrency_limit_reached` means back off. Surface both distinctly per SPEC.md §10.4 ("inline persistent UI for anything the user must act on").

## A10. Rate limits & concurrency
*(relevant to SPEC.md §5's "call all, max 3 concurrent")*

**Concurrency: 20 free.** "Pay-As-You-Go workspaces receive **a quota of 20 concurrent calls by default**." Concurrency "applies per workspace, not across the entire account." ([Retell — Understand concurrency & limits](https://docs.retellai.com/deploy/concurrency)). The pricing page confirms the first 20 are free: "Concurrency: $8.00/Concurrency/month (first 20 free)" ([Retell — Pricing](https://www.retellai.com/pricing)).

**§5's max-3-concurrent is comfortably inside the free quota.** Keep the throttle anyway — it's cost control and demo pacing, not an API constraint. Say so in the README rather than implying it's a platform limit.

**When exceeded:** inbound calls queue ~40s then transfer to `fallback_number` or terminate with `concurrency_limit_reached`. **"Outbound calls are simply rejected unless burst mode is enabled."** Burst mode adds "$0.10/min surcharge applied to the entire call duration" — **do not enable it**, it would roughly double your India per-minute cost. ([Retell — Concurrency](https://docs.retellai.com/deploy/concurrency))

**CPS (calls per second):** "exists per telephony provider (Telnyx, Twilio, Custom)" but no numeric default or maximum is documented — **UNVERIFIED**. *Settled by: contacting Retell, or observing rejections under load.* Irrelevant at Callzie's 5-row-CSV scale.

**API rate limits: UNVERIFIED.** Neither the concurrency page nor the API reference overview documents request-per-second/minute limits ([Retell — API Reference overview](https://docs.retellai.com/api-references/overview)). *Settled by: contacting Retell support.* At Callzie's volume this is not a practical concern, but don't write a README claim about it.

## A11. Extraction LLM (SPEC.md §2 / §8)

SPEC.md §2 specifies "Claude Haiku (Anthropic API) with JSON output". Current details ([Anthropic — Models overview](https://platform.claude.com/docs/en/about-claude/models/overview)):

| | Claude Haiku 4.5 |
|---|---|
| Model ID / alias | `claude-haiku-4-5-20251001` / **`claude-haiku-4-5`** |
| Price | **$1 / input MTok, $5 / output MTok** |
| Context | 200k tokens |
| Max output | 64k tokens |

**Cost is a rounding error here.** A 2-minute call transcript is maybe 500 tokens; the §8 prompt maybe 300; output ~150. That's ~$0.0016 per extraction — **less than 1% of the cost of the phone call that produced it.** Do not optimize this.

**Use structured outputs rather than "return ONLY this JSON".** SPEC.md §8 step 3 describes parse-failure retry logic; you can largely eliminate the failure mode. Haiku 4.5 supports `output_config.format` with a JSON schema, which constrains the response shape at the API level:

```ts
const response = await client.messages.create({
  model: "claude-haiku-4-5",
  max_tokens: 1024,
  messages: [{ role: "user", content: extractionPrompt(transcript) }],
  output_config: {
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          confirmed: { type: "boolean" },
          new_time:  { type: ["string", "null"] },
          notes:     { type: "string" },
          summary:   { type: "string" },
        },
        required: ["confirmed", "new_time", "notes", "summary"],
        additionalProperties: false,
      },
    },
  },
});
```

⚠️ **Still keep §8's failure path.** Structured outputs make malformed JSON very unlikely, not impossible — a `stop_reason` of `"max_tokens"` truncates mid-object, and `"refusal"` returns something that won't match your schema. SPEC.md §3 rule 5 ("extraction must never crash the pipeline") stands. Check `stop_reason` before parsing, and keep the `status = 'failed'` + `raw_llm_output` row.

⚠️ Note the older top-level `output_format` parameter is deprecated API-wide; use `output_config.format`.

## A12. Custom tools, and provisioning the four Agents (SPEC.md §13 item 5)
*(Fetched: 2026-08-12. Field shapes read off `retell-sdk@5.62.0`'s own type declarations, which are generated from the API spec and settle two contradictions the prose docs leave open.)*

SPEC.md §3 rule 12 requires verifying tool schemas before implementing them, and §13 item 5 listed this as open. This section closes the schema half. The latency half — how long a Tool may take before the Agent stalls audibly — is still **UNVERIFIED**, but it is now measurable rather than merely unknown: issue #10 added `tool_invocations.latency_ms` and every invocation records it (`lib/tools/run.ts`). That number covers Callzie's own database work, not Retell's round trip, so it answers "is our query slow" and not yet "did the caller hear silence". *Settled by* issue #12, on a live call.

### The custom tool object

**Required:** `type: "custom"`, `name`, `url`.
**`name` constraints:** a-z, A-Z, 0-9, underscores and dashes, **max 64 chars, no spaces**, and unique across all tools available at once.

**Optional, with defaults:** `description`, `method` (default `POST`), `headers`, `query_params`, `parameters` (JSON Schema), `response_variables`, `speak_during_execution` (**boolean**, default `false`), `speak_after_execution` (**boolean**, default `false`), `execution_message_type` (`"prompt" | "static_text"`, default `"prompt"`), `execution_message_description`, `timeout_ms`, `max_retry` (0–5, default 0), `args_at_root`, `parameter_type` (`"json" | "form"`), `enable_typing_sound`.

**Request body Retell POSTs:** `{ name, call, args }` — the tool name, the full call object *including the transcript so far*, and the arguments as a JSON object. Setting `args_at_root: true` hoists the arguments to the top level and **loses the `call` wrapper**; Callzie leaves it `false`, because the endpoints resolve identity from `call` and must never take an Appointment id as a model-supplied argument.

### ⚠️ `timeout_ms` defaults to 120,000 ms — the entire Callzie call

Verbatim: *"The minimum value allowed is 1000 ms (1 s), and maximum value allowed is 600,000 ms (10 min). By default, this is set to 120,000 ms (2 min)."*

That default is exactly SPEC.md §7's `max_call_duration_ms`. A single stalled Tool would therefore consume the whole conversation and bill for it, while the caller listens to silence. **Callzie sets `timeout_ms: 10_000` on all four Tools** — generous for one Postgres query, and it keeps the 120s cap meaning what it says.

`max_retry` stays at its default of **0**. Retell's own warning: *"Because retries repeat the request, only set this above 0 if your endpoint is idempotent — a retried request may be processed more than once."* `book_slot` is not idempotent, and SPEC.md §8's "retry once, silently" is an application-level rule the endpoint owns — not a transport retry that could double-book.

### ⚠️ The prose docs contradict themselves on two fields

| Field | API reference | Custom-function guide | Settled |
|---|---|---|---|
| `speak_during_execution` | boolean | a string, `"Prompt"` / `"Static Sentence"` | **boolean** — the SDK types agree with the API reference. The string values belong to the *dashboard* UI, not the API. |
| `speak_after_execution` | defaults to `false` | "defaults to true" | SDK marks it optional with no default asserted. **Set it explicitly** either way so the disagreement cannot bite. |

### Other traps

- **`parameters.type` must be `"object"`.** It is a required field on the schema object, and omitting it is the docs' own named common mistake. Callzie declares an explicit empty schema (`{ type: "object", properties: {}, required: [] }`) even for the two Tools that take no arguments, rather than omitting `parameters`.
- **`required` members must exist in `properties`**, or the model is asked for a field the endpoint never receives.
- **`tool_call_strict_mode`** (on the LLM, not the tool) is left unset. Strict schema modes generally require every property to be required, which fights `check_availability`'s optional `preferred_time`. Not worth enabling blind.
- **Retell's Tool calls authenticate against Callzie's endpoints. VERIFIED 2026-08-21** on issue #12's first live Web Call: three `check_availability` calls and one `book_slot` all returned `200`, with `tool_invocations` rows to match. The header-stripping worry is answered where it mattered — nothing 401s mid-call. **Which** of the two accepted headers carried the secret is still unrecorded, because `lib/tools/auth.ts` accepts either and neither is logged. That distinction now costs nothing: if `Authorization` were being stripped, the fallback is already carrying the traffic. *If it ever matters,* log the header name on one call rather than re-provisioning to find out.

### Dynamic variables in tools and the begin message — verified

`{{variable}}` substitution works in the **begin message**, **tool URLs**, **tool descriptions** and **property descriptions**, not just the general prompt. Callzie deliberately uses **none** in `begin_message`: an unset variable renders literally (A5), and the begin message is the first utterance, so a plumbing bug opens the call with "Hi, this is Maya calling from curly-curly-business_name". Step 1 of the prompt greets by name a beat later, so the variable buys almost nothing at the worst possible moment.

### Provisioning: listing, updating, publishing

- **`POST /v2/list-agents`** is paginated (`items`, `has_more`, `pagination_key`; `limit` max 1000) and returns **one entry per agent, not per version**. ⚠️ Its items carry only `agent_id`, `agent_name`, `channel`, `tags` and a timestamp — **not `response_engine`**. Learning which Retell LLM an Agent points at needs a `GET /get-agent/{id}` per agent.
- **`GET /v2/list-retell-llms`** is paginated the same way. LLM objects have **no name field**, so an LLM is reachable only through an Agent's `response_engine.llm_id`. Callzie labels each with `default_dynamic_variables: { callzie_template: "<business_type>" }` — inert, never referenced in a prompt — so an LLM orphaned by a crash between the two creation steps stays identifiable.
- **`PATCH /update-agent/{id}`** updates "an existing agent's **latest draft version**".
- **Publishing: not required. VERIFIED 2026-08-21.** `create-web-call` runs the **draft** version, so `scripts/create-agent.ts` is correct not to publish. Proven on issue #12's live Call: the Agents were updated by `PATCH /update-agent` only — which the docs say touches "the latest draft version" — and the very next Web Call spoke the newly-added lines verbatim ("Please hold for a moment while I book that in", "That's booked in — you're all set for…"). A published-only runtime would have replayed the previous prompt. No `client.agent.publish` call is needed.
- **Agent names are not unique.** Retell enforces nothing, so reconciling on a name has to handle finding two. The script exits non-zero rather than guessing — see ADR-0006.

`max_call_duration_ms` bounds, for the record: minimum 60,000 ms, maximum 7,200,000 ms, **default 3,600,000 (1 hour)**. Leaving it unset would let a single stuck call bill for an hour.

---

# B. Postgres

## B1. Neon free tier

**Plan limits ($0/month)** — all from [Neon — Plans](https://neon.com/docs/introduction/plans) and [Neon — Pricing](https://neon.com/pricing):

| Item | Free plan |
|---|---|
| **Storage** | **0.5 GB per project** |
| **Compute** | **100 CU-hours per project per month** — "enough to run a 0.25 CU compute in a project for 400 hours/month" |
| Autoscaling ceiling | "Up to 2 CU (8 GB RAM)" |
| **Projects** | **100** |
| **Branches** | **10 per project** (extra branches "are not available on the Free plan") |
| Data transfer (egress) | **5 GB/month** |
| Instant restore / PITR | "No charge, 6-hour limit, capped at 1 GB of change history" |
| Snapshots | 1 manual |
| Monitoring retention | 1 day |
| Support | Community |

**Archive storage:** there is no separate allotment — "Is storage cost different for archived branches? **No.** Archived branches are billed at the same rate as active branches" ([Neon — Plans FAQ](https://neon.com/docs/introduction/plans)).

**⚠️ Overage behaviour is a hard stop, not a bill:** "Storage overages cause write operations to fail until space is freed or the account upgrades" ([Neon — Plans](https://neon.com/docs/introduction/plans)). Callzie stores transcripts as `text` in `calls` and full JSON in `webhook_events.payload`. 0.5 GB is enormous for ~20 demo calls, but if you ever loop a load test, **writes start failing rather than costing money** — and your webhook handler would 500 into Retell's retry loop. Worth a line in the README's limitations section.

### Autosuspend / scale-to-zero — and its effect on the webhook path

- **Default: 5 minutes.** "When your database is inactive, it automatically scales to zero **after 5 minutes**" ([Neon — Scale to Zero](https://neon.com/docs/introduction/scale-to-zero)).
- **Cannot be disabled on Free.** "Neon compute scales to zero after an inactive period of 5 minutes. **For Neon Free plan users, this setting is fixed.** Paid plan users can disable the scale-to-zero setting" ([same](https://neon.com/docs/introduction/scale-to-zero)). The plan table's Free row reads "5 min inactivity; **cannot disable**".
- **Published cold-start figure: "a few hundred milliseconds."** "Once you query the database again, it reactivates automatically **within a few hundred milliseconds**" ([Neon — Scale to Zero](https://neon.com/docs/introduction/scale-to-zero)); repeated at [Neon — Connection latency and timeouts](https://neon.com/docs/connect/connection-latency) and [Neon — Benchmarking latency](https://neon.com/docs/guides/benchmarking-latency).
- **Two documented caveats:** "if your Neon project has been idle for **more than 7 days**, you may experience a slightly longer activation time", and "Postgres memory buffers are cold after a compute wakes up" ([Neon — Compute lifecycle](https://neon.com/docs/introduction/compute-lifecycle)).
- **UNVERIFIED:** any precise numeric SLO (p50/p99). "A few hundred milliseconds" is the only figure Neon publishes. *Settled by: measuring it on your own project.*

**What this means for `/api/webhooks/retell`.** Retell's webhook timeout is **10 seconds** (A7). A few hundred ms of Neon wake is a rounding error against that, so **this is not a real risk on Vercel** — the budget is comfortable. Two practical notes:
- The **first** call in a demo pays the cold start on *both* Vercel and Neon. If you're demoing live (§15), hit the dashboard once ~30 seconds before you start talking. That's a demo-rehearsal note, not an architecture problem.
- The "idle more than 7 days" caveat matters for a portfolio project that sits untouched between interviews. Expect the first request after a fortnight to be slow. Don't let an interviewer's first click be the cold one.

**Compute budget:** 100 CU-hours ÷ 0.25 CU = 400 hours/month. Because each wake keeps the compute alive for at least the 5-minute idle window, a fully-isolated request costs ≥5 minutes of compute — i.e. **~4,800 fully-isolated wakeups/month** before exhausting the allowance (400 h ÷ 5 min). Bursty traffic is far cheaper because wakes coalesce. Callzie will not come close.

## B2. Driver choice on Vercel — you do **not** need `@neondatabase/serverless`

**Neon's own recommendation for Vercel is plain `pg` over TCP.** Verbatim: "**The short answer: With Vercel Fluid, we recommend you use a standard Postgres TCP connection** (for example, with the node-postgres package) and a connection pool. This is the new fastest and most robust method." And the reason: "Vercel Fluid solves the 'leaked connection' problem. It keeps a function alive just long enough to safely close idle connections before the function is suspended, making pooling reliable." ([Neon — Connecting to Neon from Vercel](https://neon.com/docs/guides/vercel-connection-methods))

Their connection-method matrix ([Neon — Choosing your connection method](https://neon.com/docs/connect/choose-connection)):

| Environment | Recommended driver | Pooling |
|---|---|---|
| **Vercel (Fluid)** | **`pg` (node-postgres)** | `@vercel/functions` |
| Cloudflare Workers | `@neondatabase/serverless` | N/A |
| Netlify / Deno Deploy | `@neondatabase/serverless` | N/A |
| Railway / Render / VPS / Docker | `pg` or `postgres.js` | client-side or Neon pooling |

Setup cost, from the same Vercel page:

| Method | Protocol | Setup roundtrips | Best for |
|---|---|---|---|
| Postgres (TCP) | `postgres://` | ~8 | Fluid compute. "Once established, it's the fastest." |
| HTTP | `http://` | ~3 | Classic serverless. "Fastest for a single query where you can't pool connections." |
| WebSocket | `ws://` | ~4 | Classic serverless |

Neon's caveat: "some applications with a very high number of cold starts might, in edge cases, still see an advantage from the low initial connection time of the HTTP driver"; and "If you are on a 'classic' serverless platform (without connection pooling): Continue using the `@neondatabase/serverless` driver."

**Neon's exact published Drizzle-on-Vercel snippet** — use this:

```ts
// src/lib/db/client.ts
import { attachDatabasePool } from '@vercel/functions';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,   // the POOLED (-pooler) URL
});

attachDatabasePool(pool);

export const db = drizzle({ client: pool, schema });
```

"`attachDatabasePool` handles the connection lifecycle for you: the first request establishes a TCP connection, subsequent requests reuse it instantly, and idle connections close gracefully before Vercel suspends the function." ([Neon — Connecting to Neon from Vercel](https://neon.com/docs/guides/vercel-connection-methods))

Drizzle's own docs confirm all three drivers work, and say: "**To use Neon from a serverful environment, you can use the node-postgres or Postgres.js drivers**" ([Drizzle — Drizzle \<\> Neon Postgres](https://orm.drizzle.team/docs/connect-neon)). Install: `npm i drizzle-orm pg` + `npm i -D drizzle-kit`. Neon's ORM compatibility table lists "Drizzle — `pg`, `postgres.js`, `@neondatabase/serverless`" ([Neon — Choosing your connection method](https://neon.com/docs/connect/choose-connection)).

### Pooling: the `-pooler` hostname, and which URL goes where

Neon runs **PgBouncer** in transaction mode, "enabling up to **10,000 concurrent connections**" ([Neon — Connection pooling](https://neon.com/docs/connect/connection-pooling)). The hostname convention, verbatim:

```
# Direct
postgresql://user:pw@ep-cool-darkness-123456.us-east-2.aws.neon.tech/dbname?sslmode=require
# Pooled  (note the -pooler suffix)
postgresql://user:pw@ep-cool-darkness-123456-pooler.us-east-2.aws.neon.tech/dbname?sslmode=require
```

`max_connections` by compute size (same page): **0.25 CU → 104**, 0.5 → 209, 1 → 419, 2 → 839. "Seven connections are reserved for the Neon superuser account. For a 0.25 CU compute, this means **97 connections are available for your application**." `default_pool_size` is 90% of `max_connections`; overflow clients "wait in queue" and error with `query_wait_timeout` after **2 minutes**.

Neon calls out serverless explicitly: "Common scenarios that exceed these limits: **Serverless functions (each invocation may open a connection)**."

**⚠️ Use the *direct* URL for migrations.** "Use direct connections for… **Schema migrations (Prisma Migrate, Drizzle Kit, django-admin migrate)**, `CREATE INDEX CONCURRENTLY`, `LISTEN`/`NOTIFY`, temporary tables or prepared statements across multiple queries" ([Neon — Choosing your connection method](https://neon.com/docs/connect/choose-connection)). So:
- `drizzle.config.ts` `dbCredentials.url` → **direct** URL
- app runtime `Pool` → **pooled** (`-pooler`) URL

This is a genuine footgun: running `drizzle-kit migrate` through the pooler can fail in non-obvious ways because PgBouncer's transaction mode doesn't hold session state.

**One tension worth naming:** Neon also says "If you use a pooled Neon connection, avoid adding client-side pooling on top. Let Neon handle it" ([same](https://neon.com/docs/connect/choose-connection)) — which sits against the `pg` + `attachDatabasePool` recipe on their Vercel page. The sane reading is: follow the Vercel page (it's the more specific, more recent guidance), but keep the client-side pool small (`max: 3–5`). At Callzie's volume it makes no measurable difference either way.

## B3. Neon ↔ Vercel integration, and "Vercel Postgres is now Neon"

Three documented paths ([Neon — Integrating Neon with Vercel](https://neon.com/docs/guides/vercel-overview), [Neon — Vercel-Managed Integration](https://neon.com/docs/guides/vercel-managed-integration)):
- **Vercel-Managed** (Vercel Marketplace) — "Creates a Neon account + project for you… adds a new organization named `Vercel: <team-name>`… **Injects the required database environment variables (`DATABASE_URL`, etc.) into your Vercel project**… Optionally creates a dedicated database branch for every Preview Deployment", with billing handled inside Vercel. Terminology note: "a 'Database' in Vercel is a **Project** in Neon."
- **Neon-Managed** — link an existing Neon project, billing stays with Neon.
- **Manual** — paste the connection string yourself.

**Vercel Postgres is Neon now:** "**Vercel transitioned all Vercel Postgres stores to Neon's native integration (Q4 2024 – Q1 2025).**" `@vercel/postgres` "Still works… **Will be deprecated** — no longer actively maintained by Vercel"; migrate via `@neondatabase/vercel-postgres-compat` or `@neondatabase/serverless` ([Neon — Vercel Postgres Transition Guide](https://neon.com/docs/guides/vercel-postgres-transition-guide)). **Do not reach for `@vercel/postgres` in a new 2026 build.**

**Free allotment via the Vercel path vs direct signup: UNVERIFIED.** Vercel's listing says only "Plans starting at $0" ([Vercel — Neon for Vercel](https://vercel.com/marketplace/neon)); no first-party page enumerates a *different* free allotment for the Vercel-managed route. Parity with B1 is strongly implied but never stated. ⚠️ Beware stale numbers: the transition guide still shows "Hobby → Free: Compute Hours 60 → 190, Storage 256 MB → 512 MB, Databases 1 → 10" — those are **2024–25 transition-era figures that conflict with the current plans page** (100 CU-hours/project, 0.5 GB/project, 100 projects). **The plans/pricing pages are the current authority.** *Settled by: signing up and reading your own usage page.*

> **Recommendation:** use the **Vercel Marketplace (Vercel-Managed) integration**. It injects `DATABASE_URL` automatically — which kills an entire class of "works locally, 500s in prod" bugs on Day 1 — and gives you per-preview branches for free. SPEC.md §2 lists `DATABASE_URL` as an env var to define; with this path Vercel sets it for you and you only define it locally in `.env`.

## B4. Alternatives — Supabase and Google Cloud

### Supabase free tier

Verbatim from [Supabase — Pricing](https://supabase.com/pricing): "$0/month… Unlimited API requests • **50,000 monthly active users** • **500 MB database size** • **Shared CPU • 500 MB RAM** • **5 GB egress** • 5 GB cached egress • 1 GB file storage • Community support." Also: "**Free projects are paused after 1 week of inactivity. Limit of 2 active projects.**" No automatic backups, no PITR, no branching on Free; Auth audit logs 1 hour.

**⚠️ The pausing behaviour disqualifies it for this app.** "Supabase pauses Free Plan projects that show low activity over a **7-day period**… **Typically a few user requests to the database each day over the previous week is enough to keep the project from being paused.**" Restore is manual — "Click **Resume project**" — available "for up to **1 year** after it was paused" ([Supabase — Project Pausing](https://supabase.com/docs/guides/platform/free-project-pausing)).

For a portfolio project whose entire value is *a live URL an interviewer can click weeks later*, a database that silently pauses after a quiet week is the wrong failure mode. **Neon scales to zero and wakes in hundreds of milliseconds; Supabase pauses and requires a human to click Resume.** That difference is the whole decision.

Connection strings ([Supabase — Connect to your database](https://supabase.com/docs/guides/database/connecting-to-postgres)): direct `db.[project-id].supabase.co:5432` (IPv6 by default; IPv4 needs a paid add-on — another gotcha), Supavisor session mode `...pooler.supabase.com:5432`, Supavisor transaction mode `...pooler.supabase.com:6543` — "ideal for serverless or edge functions" but "**Transaction mode does not support prepared statements**". With Drizzle that means: "If you use connection pooling via Supabase with 'Transaction' pool mode enabled, **you must turn off prepare**" — `postgres(process.env.DATABASE_URL, { prepare: false })` ([Drizzle — Drizzle \<\> Supabase](https://orm.drizzle.team/docs/connect-supabase)). Drizzle works fine with Supabase; that's not the issue.

**UNVERIFIED:** per-connection limits on the *Free* compute — the pricing page's connection table starts at Micro (Direct 60 / Pooler 200) and marks Micro "Not included in Free Plan".

### Google Cloud Postgres — is anything free? **No.**

**There is no Always Free Postgres on GCP, of any kind.** Neither Cloud SQL nor AlloyDB appears in the Free Tier usage-limits list; among databases only **Firestore** has an Always Free allotment ("1 GiB of storage per project. 50,000 reads, 20,000 writes, and 20,000 deletes per day per project") ([Google — Free Cloud features and trial offer](https://docs.cloud.google.com/free/docs/free-cloud-features)).

**There is no free micro instance.** `db-f1-micro` is a **paid** machine type in the Cloud SQL pricing table — it is not an Always Free allotment ([Google — Cloud SQL pricing](https://cloud.google.com/sql/pricing)).

**Being precise about the three different "free" things** (this is the distinction the question asks for):

1. **Always Free** — perpetual monthly allotments. **Contains no Postgres.**
2. **$300 / 90-day Welcome credit** — a trial *credit*, not a tier. "If you don't upgrade to a Paid billing account before 90 days pass **or if you spend the $300 in free credit, then your Free Trial billing account will be closed** and all of its associated projects and resources will be [deleted]" ([Google — Free Cloud features](https://docs.cloud.google.com/free/docs/free-cloud-features)). A Cloud SQL instance run under this is **credit-funded, not free**, and dies with the trial.
3. **Product-specific 30-day trials** — separate again, and single-use:
   - **Cloud SQL free trial instance**: Enterprise Plus, N2, **8 vCPU / 64 GB**, 100 GB storage. "No charge for the free trial instance and instance resources, but **you are charged for data transfer costs**…" "Free trial instances don't support backups or restore." "SLAs don't apply." "**One free trial instance allowed per project lifecycle.**" After 30 days "your instance stops serving requests", kept for a 90-day grace period, then "scheduled for deletion" ([Google — Cloud SQL free trial instance](https://docs.cloud.google.com/sql/docs/postgres/free-trial-instance)).
   - **AlloyDB free trial cluster**: "up to 30 days", "8 vCPU basic primary instance that automatically scales storage up to 1TB". "One free trial cluster allowed per project lifecycle." 15-day grace period. And explicitly additive: "The AlloyDB free trial cluster is **in addition to** the $300 credits" ([Google — AlloyDB free trial clusters](https://docs.cloud.google.com/alloydb/docs/free-trial-cluster), [Google — AlloyDB pricing](https://cloud.google.com/alloydb/pricing)).

**Concrete cost of the cheapest real Cloud SQL Postgres** (Enterprise edition, Iowa/us-central1, from [Google — Cloud SQL pricing](https://cloud.google.com/sql/pricing)):

| Machine type | vCPU | RAM | Hourly |
|---|---|---|---|
| **db-f1-micro** | shared | 0.6 GiB | **$0.0105/hr** |
| db-g1-small | shared | 1.7 GiB | $0.035/hr |
| HA db-f1-micro | shared | 0.6 GiB | $0.021/hr |

Footnote, verbatim: "*Shared CPU machine types (db-f1-micro and db-g1-small) are **not covered by the Cloud SQL SLA**." Storage: SSD **$0.000232877/GiB-hour**. Internet egress **$0.19/GiB**. Idle public IPv4: **$0.01/hour** (~$7.30/month even on a stopped instance).

At 730 h/month (*my arithmetic*):

| Configuration | Monthly |
|---|---|
| db-f1-micro, no HA, compute only | **$7.67** |
| + 10 GiB SSD | + $1.70 → **≈ $9.37/month** |
| db-g1-small + 10 GiB SSD | **≈ $27.25/month** |
| Smallest dedicated-core Enterprise (1 vCPU + 3.75 GiB min) + 10 GiB SSD | **≈ $51/month** |
| AlloyDB, 2 vCPU / 16 GiB node, before storage | **≈ $227/month** |

**UNVERIFIED:** the 10 GiB figure — I found no first-party statement of Cloud SQL's minimum/default storage capacity; treat it as illustrative. The Enterprise memory floor *is* documented: "0.9 GB to 6.5 GB per vCPU (must be a multiple of 256 MB and at least 3.75 GB)" ([Google — About instance settings](https://docs.cloud.google.com/sql/docs/postgres/instance-settings)). Also UNVERIFIED that 2 vCPU is AlloyDB's minimum node size.

### Verdict

**Neon Free is the right and only sensible choice**, and SPEC.md §2 already picked it. Ranked:

| | Free? | Failure mode when idle | Verdict |
|---|---|---|---|
| **Neon** | Yes — 0.5 GB, 100 CU-hr | Scales to zero, wakes in **~hundreds of ms**, automatic | ✅ **Use this** |
| Supabase | Yes — 500 MB | **Pauses after 1 week; needs a human to click Resume** | ❌ wrong failure mode for a live demo URL |
| Cloud SQL | **No** | n/a | ❌ ~$9.37/mo minimum, no SLA at that size |
| AlloyDB | **No** | n/a | ❌ ~$227/mo |

---

# C. Deploying on Google Cloud for free — and the Vercel conflict

## C1. What is actually in Google Cloud's Always Free tier today

**A billing account with a payment method is required — there is no card-free path.** "To use products that have a Free Tier, you need a Google Cloud billing account", which must be "either a Paid billing account or Free Trial billing account" ([Google — Free Google Cloud features and trial offer](https://docs.cloud.google.com/free/docs/free-cloud-features)). Signing up for the Free Trial requires "a credit card or other payment method that is valid for the period of the Free Trial." Limits "are calculated per billing account."

**The $300 credit is NOT a free tier — the distinction is precise.** The Free Trial gives "**$300 in free Welcome credit which is valid for 90 days**"; separately, "During the Free Trial, you also get access to the Google Cloud Free Tier" ([same](https://docs.cloud.google.com/free/docs/free-cloud-features)). They are two different things stacked on one account:
- **Always Free** — perpetual monthly allotments, "no end date", survives after the trial.
- **$300 / 90-day credit** — a one-time, expiring balance that pays for *overage* beyond Always Free.

If you exceed Always Free on a trial account, "your $300 Welcome credit pays for the overage"; on a paid account "you will be billed for the overage." If you never upgrade and the credit expires, the account auto-closes → 30-day grace period → **resources permanently deleted**. Building a portfolio deliverable on an expiring trial credit is how a "live demo URL" dies 90 days after the interview.

**Always Free allotments relevant to hosting this backend:**

| Product | Always Free allotment |
|---|---|
| **Cloud Run** (request-based billing) | **2,000,000 requests/month**, **180,000 vCPU-seconds**, **360,000 GiB-seconds**, **1 GB** North America egress/month |
| **Cloud Run** (instance-based billing) | **240,000 vCPU-seconds** + **450,000 GiB-seconds**/month, and **no free request allowance** |
| **Cloud Run functions** | **2,000,000 invocations**, **400,000 GB-seconds**, **200,000 GHz-seconds**, **5 GB** egress/month |
| **App Engine standard** (still offered) | **28 instance-hours/day of F1**, **9 instance-hours/day of B1**, **1 GB** egress/day |
| **Artifact Registry** | **0.5 GB storage/month** (then ~$0.10/GiB-month) |
| **Cloud Build** | **2,500 build-minutes/month** — footnoted as a **"promotional"** free tier for `e2-standard-2`, "subject to change" |
| Compute Engine | 1 non-preemptible `e2-micro`/month in select US regions |

Sources: [Google — Free Cloud features](https://docs.cloud.google.com/free/docs/free-cloud-features), [Cloud Run pricing](https://cloud.google.com/run/pricing), [Artifact Registry pricing](https://cloud.google.com/artifact-registry/pricing), [Cloud Build pricing](https://cloud.google.com/build/pricing).

**Scoping:** "The free tier usage is **aggregated across projects by billing account** and resets every month… **The free tier is applied as a spending based discount using Tier 1 pricing**" ([Cloud Run pricing](https://cloud.google.com/run/pricing)). At Tier 1 rates the Cloud Run discount is worth exactly **$5.22/month** (180,000 × $0.000024 + 360,000 × $0.0000025 = $4.32 + $0.90), corroborated by Google's own worked examples on that page — several show a $5.22 delta between "estimated cost" and "without the vCPU/Memory free tier".

**⚠️ The deploy-path trap, verbatim:** "When deploying from source or creating a function, Cloud Run uses **Cloud Build** to convert your source code into an executable image. The images are created in Cloud Build and **stored in Artifact Registry**… **If you deploy your source code or function to Artifact Registry and exceed the Artifact Registry free tier usage, you will incur charges for deploying your functions, even when your use of Cloud Run falls within the free tier**" ([Cloud Run pricing](https://cloud.google.com/run/pricing)). A Next.js container image plus accumulated revisions blows past 0.5 GB quickly. You'd need an Artifact Registry cleanup policy — extra infrastructure to remember, for a portfolio project.

## C2. Would this app fit inside Cloud Run's Always Free allotment?

**Yes, comfortably — compute is not the constraint.** Estimating against the real numbers at 1 vCPU / 512 MiB, request-based billing, and a generous 500 requests/day (~15,000/month) averaging 300 ms:

| Resource | Estimated use | Always Free | Headroom |
|---|---|---|---|
| Requests | 15,000/mo | 2,000,000 | **133×** |
| vCPU-seconds | 15,000 × 0.3 × 1 = **4,500** | 180,000 | **40×** |
| GiB-seconds | 15,000 × 0.3 × 0.5 = **2,250** | 360,000 | **160×** |
| Egress (NA) | well under 1 GB | 1 GB | fine |

Even at 10× that traffic it stays free. The **recurring** costs that would actually bite are **Artifact Registry above 0.5 GB** (stale image revisions) and **Cloud Build above 2,500 min/month** — the latter a promotional allotment Google reserves the right to change.

**With `min-instances=1`** (to kill cold starts on the webhook path), using the separate, cheaper "Idle time (Min instance)" CPU rate of **$0.0000025/vCPU-s** ([Cloud Run pricing](https://cloud.google.com/run/pricing)) over 2,628,000 s/month:

| Config | Gross idle cost/mo | After the $5.22 free-tier discount |
|---|---|---|
| 0.08 vCPU / 128 MiB (minimum) | ~$1.35 | **$0** |
| 0.5 vCPU / 512 MiB | ~$6.57 | ~**$1.35** |
| 1 vCPU / 512 MiB (realistic for Next.js) | ~$9.86 | ~**$4.64** |

Below 1 vCPU, Cloud Run forces "max concurrency = 1, request-based billing, and gen1 execution environment", and 0.08 vCPU caps memory at 512 MiB ([Google — Configure CPU limits](https://docs.cloud.google.com/run/docs/configuring/services/cpu)) — not a sane config for Next.js. **UNVERIFIED:** whether idle min-instance vCPU-seconds consume the 180,000/360,000 unit allowances or only draw down the $5.22 discount value; Google's "spending based discount" wording implies the latter, and the free-tier table scopes those figures to "Limits for request-based billing". *Settled by: running it a month and reading the bill.*

## C3. The Vercel vs Cloud Run conflict

**Stating the conflict plainly.** SPEC.md §2 fixes the stack ("Next.js 15, App Router… Deployed on Vercel", "Postgres on Neon") and marks the whole table **"(fixed, do not substitute)"**. §1 makes "Live deployed URL on Vercel" deliverable #1, and §14 requires "Live URL works from a phone browser". Moving to Cloud Run is a spec change, not an optimization — **I am not endorsing it.** Here is what it would actually cost, so the call is informed rather than assumed.

### (a) What deploying Next.js 15 to Cloud Run would involve

Google does publish an official path: [Quickstart: Build and deploy a Next.js web app to Cloud Run](https://docs.cloud.google.com/run/docs/quickstarts/frameworks/deploy-nextjs-service). It uses `gcloud run deploy --source .` with **buildpacks, no Dockerfile**, and notably does **not** mention `output: 'standalone'` or `PORT`. [Deploy services from source code](https://docs.cloud.google.com/run/docs/deploying-source-code) confirms `--source .` "auto-detects a Dockerfile and uses it if present"; otherwise buildpacks detect the language. It "automatically creates an Artifact Registry repository with the name `cloud-run-source-deploy`."

For a production-shaped deploy you'd want the Dockerfile path:

1. **`output: 'standalone'`** in `next.config.ts` — produces `.next/standalone` + a minimal `server.js`. Caveat from Next's own docs: it "does not copy the `public` or `.next/static` folders by default", so the Dockerfile needs `cp -r public .next/standalone/ && cp -r .next/static .next/standalone/.next/` ([Next.js — `output`](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)).
2. **Honor the container contract** — the ingress container "must listen on `0.0.0.0`", not `127.0.0.1`, on the port from the injected **`PORT`** env var; "By default, requests are sent to `8080`" ([Google — Container runtime contract](https://docs.cloud.google.com/run/docs/container-contract)). Next's standalone docs match: "run `PORT=8080 HOSTNAME=0.0.0.0 node server.js`". So `ENV HOSTNAME=0.0.0.0`, and let Cloud Run inject `PORT`.
3. **Multi-stage Dockerfile** + `CMD ["node","server.js"]`. Next.js maintains a first-party template at [github.com/nextjs/deploy-google-cloud-run](https://github.com/nextjs/deploy-google-cloud-run), linked from [Next.js — Deploying](https://nextjs.org/docs/app/getting-started/deploying), plus [examples/with-docker](https://github.com/vercel/next.js/tree/canary/examples/with-docker).
4. **Cold starts on the webhook path.** With `min-instances=0`, "when a revision does not receive any traffic, by default, it is scaled to zero instances", though Cloud Run "might keep instances idle for a period of time after they finish handling requests (**up to 15 minutes**)" ([Google — About instance autoscaling](https://docs.cloud.google.com/run/docs/about-instance-autoscaling)). **This directly threatens SPEC.md §3 rule 3 and Retell's 10-second webhook timeout (A7)**: a cold Next.js container start plus a Neon cold start (B1) could plausibly exceed 10 s, triggering Retell retries. Your idempotency handles it, but it's an avoidable failure mode on the demo path.
5. **`min-instances=1` fixes cold starts but costs money** — ~$4.64/month at 1 vCPU / 512 MiB after the discount (C2). It "will incur cost even when the service is not actively serving requests" ([Google — Minimum instances](https://docs.cloud.google.com/run/docs/configuring/min-instances)).
6. **⚠️ The `after()` trap on Cloud Run.** SPEC.md §3 rule 3's fire-and-forget extraction relies on Next's `after()`. On Cloud Run, CPU is throttled once the response is sent unless you enable CPU-always-allocated or instance-based billing — so your Haiku call would run throttled or stall. On Vercel this is native via `waitUntil`. That is a behavioural difference, not just a config difference.

### (b) Is a split sensible? (Next.js on Vercel, something on GCP)

**No — there is nothing to split.** Callzie is one Next.js app: a dashboard, ~6 API routes, one webhook receiver. There is no long-running worker, no queue consumer, no GPU job, and §6 explicitly forbids building a scheduler. Splitting would add a network hop, a second deploy pipeline, a second secret store, and cross-origin auth — to relocate roughly 50 lines of extraction code. That is complexity with no payoff, and it puts the §11 five-day schedule at risk for zero user-visible benefit.

If GCP must appear in the story, the honest framing is architectural, not deployed: "the webhook receiver and extraction step are stateless and containerize cleanly — here's the Dockerfile." A README section, not a second production environment.

### (c) Does Vercel Hobby actually cover this app?

**Technically yes, with enormous headroom.** From [Vercel — Functions Limits](https://vercel.com/docs/functions/limitations), [Vercel — Configuring maximum duration](https://vercel.com/docs/functions/configuring-functions/duration), and [Vercel — Limits](https://vercel.com/docs/limits):

| Limit | Hobby | Callzie's need |
|---|---|---|
| **Function max duration (Fluid compute, default for new projects)** | **300 s — default *and* maximum** | Webhook returns in ms; Haiku call 3–10 s. **30×+ headroom** |
| Function max duration (legacy: pre-2025-04-23 projects not on Fluid) | 10 s default / 60 s max | n/a — new project |
| Edge runtime | must start responding within 25 s, may stream to 300 s | not used |
| Memory | 2 GB / 1 vCPU (fixed on Hobby) | ample |
| Fast Data Transfer | **100 GB/month** | negligible |
| Function invocations | **1,000,000/month** | negligible |
| Edge requests | 1,000,000/month | negligible |
| Active CPU | 4 CPU-hrs/month | negligible |
| Build time per deployment | 45 min | fine |
| Deployments | 100/day | fine |
| Runtime log retention | **1 hour** | ⚠️ see Watch-outs |
| Request/response body | **4.5 MB** (`413 FUNCTION_PAYLOAD_TOO_LARGE` above) | webhooks are KBs |

Also note: "Starting in **Next.js 16.3**, setting `runtime = 'edge'` is no longer supported. Routes and pages run on Node.js" ([Vercel — Edge Runtime](https://vercel.com/docs/functions/runtimes/edge)). Irrelevant here — use the Node runtime, which is what you want for `crypto` and `pg` anyway.

**Cron on Hobby is genuinely limited:** 100 cron jobs per project but a **minimum interval of once per day**, with per-hour precision — "a cron job configured as `0 1 * * *` will trigger anywhere between 1:00 am and 1:59 am", and more frequent expressions "will fail during deployment" with *"Hobby accounts are limited to daily cron jobs"* ([Vercel — Cron jobs usage & pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing)). **This does not affect Callzie** — SPEC.md §6 step 5 says "Simple immediate retry is acceptable; do not build a scheduler." Good call by the spec; a cron-based retry would have hit this wall on Day 4.

**Fire-and-forget: use `after()`, not `waitUntil`.** `after()` is stable since Next.js 15.1 and works in Route Handlers ([Next.js — `after`](https://nextjs.org/docs/app/api-reference/functions/after)). Vercel's own guidance: "If you're using **Next.js 15.1 or above, we recommend using the built-in `after()` function from `next/server` instead of `waitUntil()`**" ([Vercel — @vercel/functions](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package)). Three properties that matter for §3 rule 3:
- "`after` will run for the platform's **default or configured max duration of your route**" — your callback shares the 300 s budget. Plenty.
- "`after` will be executed **even if the response didn't complete successfully**."
- On Vercel it's implemented via `waitUntil`, "which extends the lifetime of a serverless invocation until all promises passed to `waitUntil` have settled."

> **This means SPEC.md §3 rule 3's escape hatch ("trigger it as a fire-and-forget internal request instead of inline") is unnecessary on Vercel.** `after()` gets you the same isolation without a self-HTTP call and without an internal-secret header. Keep `/api/internal/extract` as a route so you can re-run extraction manually from the UI (useful for the §10.3 "Retry" affordance), but call the extraction function directly inside `after()` rather than POSTing to yourself.

**UNVERIFIED (by omission):** no plan gate is documented for `after()` / `waitUntil` on Hobby. Vercel documents plan gates explicitly elsewhere (Secure Compute, Log Drains, extended `maxDuration`), and none appears here — so it is very likely fine, but the docs never affirmatively say "available on Hobby". *Settled by: deploying and observing.*

### ⚠️ The one real Vercel Hobby risk: the commercial-use clause

This, not function duration, is the thing to actually think about. Verbatim from [Vercel — Fair Use Guidelines § Commercial usage](https://vercel.com/docs/limits/fair-use-guidelines):

> "**Hobby teams** are restricted to non-commercial personal use only. All commercial usage of the platform requires either a Pro or Enterprise plan.
>
> Commercial usage is defined as any Deployment that is used for the purpose of financial gain of **anyone** involved in **any part of the production** of the project, **including a paid employee or consultant writing the code**. Examples of this include, but are not limited to, the following:
> - Any method of requesting or processing payment from visitors of the site
> - Advertising the sale of a product or service
> - **Receiving payment to create, update, or host the site**
> - Affiliate linking is the primary purpose of the site
> - The inclusion of advertisements…"

Also: "Asking for Donations fall under commercial usage." The Hobby plan page repeats it: "the Hobby plan restricts users to **non-commercial, personal use only**" ([Vercel — Hobby Plan](https://vercel.com/docs/plans/hobby); backstop [Vercel — Terms of Service § Fair Use](https://vercel.com/legal/terms#fair-use)).

**Reading for Callzie:** SPEC.md §1 calls it "a single-user SaaS" and §15 is a sales pitch — but the *deployment* is a portfolio/interview demo with **no payments, no pricing page, no ads, no donations, and nobody paid to build it**. That is squarely non-commercial personal use and is fine on Hobby. Two things would flip it: adding a pricing or "Start free trial" commercial affordance to the deployed site, or being paid to build it. **Keep the deployed app free of any sale/pricing/payment surface** — which the spec's three-screen scope already does. Vercel's own advice if unsure: "please contact the Vercel Support team."

### Honest recommendation

**Stay on Vercel + Neon. Do not move to Cloud Run.** The tradeoff, stated rather than hidden:

| | Vercel Hobby | Cloud Run Always Free |
|---|---|---|
| Cost for this app | $0 | $0 at min-instances=0; ~$4.64/mo to avoid cold starts |
| Card required | **No** | **Yes** |
| Setup cost | `git push` | Dockerfile + standalone output + Artifact Registry cleanup + IAM |
| Cold start on the webhook path | none (Fluid) | real; threatens Retell's 10 s timeout |
| `after()` fire-and-forget | native (`waitUntil`) | ⚠️ CPU throttled post-response unless reconfigured |
| Spec compliance | ✅ §1, §2, §14 | ❌ contradicts §2 "do not substitute" |
| Terms risk | commercial-use clause (manageable — see above) | none |

**What Cloud Run genuinely wins on:** no commercial-use restriction. If Callzie ever became a real product taking payment, Cloud Run's free tier would remain legitimate where Vercel Hobby would not. That is the one honest argument for it — and it is a *future* argument. It belongs in the README's roadmap, not in this week's build.

**The five-day budget is the decisive factor.** SPEC.md §11 already loads Day 1 with repo + Clerk + Neon + migrations + Vercel deploy *and* Retell account setup *and* the kill-switch test. Adding container work to that day, when the India question (A2) is the day's real risk, is how the schedule fails.

---

# D. Seeing the DB tables from Windows 11

## D1. Inspecting the database from Windows 11

### Option 1 (recommended primary) — Neon Console → Tables

Zero install, and it is the same tool as option 2: Neon's Tables view is a "visual editor **powered by Drizzle Studio**" ([Neon — Tables](https://neon.com/docs/guides/tables)). Browse and edit cells inline, Add Record, bulk delete, filters and saved views, export JSON/CSV, copy rows as `INSERT`s, copy `CREATE TABLE`. Schema ops too: create/alter/drop schemas, tables, views, enums, roles, privileges, RLS policies. ⚠️ Documented gotcha: you must press Enter for new-record input to register, or you lose it.

Neon's **SQL Editor** complements it ([Neon — Query with SQL Editor](https://neon.com/docs/get-started-with-neon/query-with-neon-sql-editor)): run queries against any branch, saved queries, automatic query history, **Explain** and **Analyze** (`EXPLAIN ANALYZE`), Time Travel queries, export CSV/JSON/XLSX. Usefully, **it supports psql meta-commands** (`\dt`, `\d`, `\l`) — which covers most of why you'd reach for psql at all. There is no full psql terminal in the browser.

**Works over SSL remotely: trivially yes** — it's the provider's own console. No connection string to fumble, no PowerShell quoting, and it's the only option usable from a phone during a demo.

### Option 2 (recommended backup) — Drizzle Studio

```powershell
npx drizzle-kit studio
```

It "spins up a server for Drizzle Studio hosted on local.drizzle.studio… It requires you to specify database connection credentials via `drizzle.config.ts` config file" ([Drizzle — drizzle-kit studio](https://orm.drizzle.team/docs/drizzle-kit-studio)). Current `drizzle-kit` is **0.31.10** (npm registry, `drizzle-kit/latest`).

**Where it runs:** "Drizzle Studio will be launched on the `https://local.drizzle.studio` host, and studio server will be launched on `127.0.0.1` host" ([Drizzle — Studio overview](https://orm.drizzle.team/drizzle-studio/overview)). Default studio server port **4983**. Flags: `--port=3000`, `--host=0.0.0.0`, `--verbose` ("enable logging of every SQL statement").

⚠️ **On the `local.drizzle.studio` question — be precise, because it's a fair thing to be uneasy about.** The docs describe the split (UI page served from Drizzle's domain, DB server bound to `127.0.0.1`) but contain **no statement about where data or credentials go**, and Studio itself "is not open source" (Drizzle ORM and Kit are). The only adjacent guidance: "Our hosted version Drizzle Studio is meant to be used for local development and **not meant to be used on remote (VPS, etc.)**" ([Drizzle — drizzle-kit studio](https://orm.drizzle.team/docs/drizzle-kit-studio)). **UNVERIFIED:** that `local.drizzle.studio` resolves to 127.0.0.1, and that no data or credentials transit Drizzle-controlled infrastructure. *Settled by: `nslookup local.drizzle.studio` plus watching the browser network tab.* Strong circumstantial evidence it's fine: Neon ships it inside their own console. But don't assert it in a README.

**Config, copied from Drizzle's current Neon getting-started page** ([Drizzle — Get started with Neon](https://orm.drizzle.team/docs/get-started/neon-new)):

```ts
// drizzle.config.ts
import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL_DIRECT!,   // ← DIRECT url, not -pooler (see B2)
  },
});
```

Field names verified against [Drizzle — drizzle.config.ts](https://orm.drizzle.team/docs/drizzle-config-file): `dialect` (`"postgresql" | "mysql" | "sqlite" | …`), `schema` (string or glob), `out` (default `"drizzle"`), **`dbCredentials.url`** (current name — *not* `connectionString`), `verbose` (boolean). ⚠️ **`strict` is UNVERIFIED / likely stale** — it does not appear in the current config reference. Documented siblings are `breakpoints`, `migrations`, `introspect.casing`, `tablesFilter`, `schemaFilter`, `extensionsFilters`, `entities.roles`, `driver`. The `push` command's data-loss escape hatch is the `--force` **flag**, not a `strict` config key ([Drizzle — push](https://orm.drizzle.team/docs/drizzle-kit-push)).

**Remote Neon URL with SSL:** the `?sslmode=require&channel_binding=require` params ride along inside `dbCredentials.url`, and Drizzle's own Neon guide passes `process.env.DATABASE_URL` unmodified. **UNVERIFIED:** an explicit Drizzle sentence stating "studio works against a remote SSL URL" — strongly implied, never stated in those words.

**drizzle-kit commands** ([Drizzle — Migrations with Drizzle Kit](https://orm.drizzle.team/docs/kit-overview)):

| Command | What it does |
|---|---|
| `generate` | Snapshots schema to JSON, diffs vs last snapshot, emits a timestamped folder with `migration.sql` + `snapshot.json` |
| `migrate` | Reads `.sql` files, checks the migrations log table, applies unapplied ones and records them |
| `push` | Introspects DB, diffs vs schema, applies SQL directly — **no migration files** |
| `pull` | Introspects an existing DB into a Drizzle schema |
| `check` | Validates generated migrations for race conditions / collisions |
| `up` | Upgrades snapshots of previously generated migrations |
| `export` | TS schema → raw SQL DDL on stdout |

The log table defaults to `__drizzle_migrations` in schema `drizzle`, configurable via `migrations: { table, schema }` ([Drizzle — migrate](https://orm.drizzle.team/docs/drizzle-kit-migrate)).

> **Workflow for Callzie:** SPEC.md §2 requires "**Migrations checked into repo**", so the answer is **`generate` → review the `.sql` → `migrate`**, not `push`. Drizzle does recommend `push` for "rapid prototyping" and names Neon specifically as a good fit ([Drizzle — push](https://orm.drizzle.team/docs/drizzle-kit-push)), and it's fine while you're churning the schema on Day 1 — but the committed artifact must be generated migrations, or you fail the spec.

### Option 3 — psql on Windows 11

**Getting it.** postgresql.org points Windows users to EDB's interactive installer at [enterprisedb.com/downloads/postgres-postgresql-downloads](https://www.enterprisedb.com/downloads/postgres-postgresql-downloads), which "includes the PostgreSQL server, pgAdmin… and StackBuilder" ([PostgreSQL — Windows downloads](https://www.postgresql.org/download/windows/)). ⚠️ **UNVERIFIED:** a client-tools-only install option — that page documents no such mode. The documented no-server alternative is the standalone binaries zip at [enterprisedb.com/download-postgresql-binaries](https://www.enterprisedb.com/download-postgresql-binaries), "binary-only download without the installer wrapper."

**winget — package ids are versioned.** Verified against Microsoft's official [winget-pkgs](https://github.com/microsoft/winget-pkgs/tree/master/manifests/p/PostgreSQL/PostgreSQL) repo, which contains folders `9`–`18`; the manifest confirms `PackageIdentifier: PostgreSQL.PostgreSQL.18`, `PackageVersion: 18.4-2`. There is **no unversioned `PostgreSQL.PostgreSQL` id** — a bare `winget install PostgreSQL` will not do what you expect.

```powershell
winget install --id PostgreSQL.PostgreSQL.18 --exact
# also under the same publisher: PostgreSQL.pgAdmin, PostgreSQL.psqlODBC
```

**scoop** — the Main bucket has `postgresql` (18.4-2), and it adds the package `bin` directory to PATH so `psql` becomes available ([ScoopInstaller/Main manifest](https://raw.githubusercontent.com/ScoopInstaller/Main/master/bucket/postgresql.json)):

```powershell
scoop install postgresql
```

**Connecting to Neon.** Format ([Neon — Connect from any app](https://neon.com/docs/connect/connect-from-any-app)):

```
postgresql://[role]:[password]@[hostname]/[dbname]?sslmode=require&channel_binding=require
```

Neon requires SSL on all connections and recommends the strictest mode: "always use `verify-full` mode, which ensures the highest level of security" ([Neon — Connect securely](https://neon.com/docs/connect/connect-securely)). Neon's chain roots at Let's Encrypt ISRG Root X1, and on Windows libpq uses the system root store by default — so no CA file wrangling.

**⚠️ PowerShell-specific gotchas — this is where 20 minutes disappear.** The URI contains `&`, which PowerShell treats as a reserved token, and `$` interpolates inside double quotes (Neon-generated passwords frequently contain `$`).

```powershell
# BEST: single quotes — no $ interpolation, & is inert
psql 'postgresql://neondb_owner:AbC$123@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=verify-full&channel_binding=require'

# Or hard-stop the parser with the stop-parsing token
psql --% "postgresql://user:pw@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=verify-full"

# Or skip URL quoting entirely with env vars
$env:PGHOST     = 'ep-xxx.us-east-2.aws.neon.tech'
$env:PGUSER     = 'neondb_owner'
$env:PGDATABASE = 'neondb'
$env:PGSSLMODE  = 'verify-full'
$env:PGPASSWORD = 'AbC$123'
psql
```

`--%` "prevents PowerShell from interpreting strings as PowerShell commands and expressions… Place the stop-parsing token after the program name" ([Microsoft — about_Special_Characters](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_special_characters)). Note PostgreSQL's own caution on `PGPASSWORD`: "Use of this environment variable is not recommended for security reasons, as some operating systems allow non-root users to see process environment variables via `ps`" ([PostgreSQL — Environment Variables](https://www.postgresql.org/docs/current/libpq-envars.html)). Special characters in the URI must be percent-encoded per RFC 3986 ([PostgreSQL — libpq connect](https://www.postgresql.org/docs/current/libpq-connect.html)) — relevant precisely because Neon-generated passwords can contain URI-reserved characters.

**Shortcut that sidesteps all of the above:** `neon connection-string --psql -- -c "SELECT version()"` ([Neon — Query with psql](https://neon.com/docs/connect/query-with-psql-editor)). The Neon CLI npm package is **`neon`** (binary `neon`; `neonctl` is an alias; the Homebrew formula is `neonctl`): `npm i -g neon@latest` (requires Node 20.19.0+), or `npx neon <command>` ([Neon — CLI install](https://neon.com/docs/reference/cli-install)). Windows also has a standalone `neon-win-x64.exe`. Auth precedence: `--api-key` → `NEON_API_KEY` → `credentials.json` → interactive `neon auth` ([Neon — CLI reference](https://neon.com/docs/reference/neon-cli)).

### Option 4 — GUI clients

Neon's general guidance ([Neon — Connect a GUI application](https://neon.com/docs/connect/connect-postgres-gui)): supply hostname / port 5432 / database / role / password from the Console's Connect modal and enable the client's **Require SSL** option — **Neon routes on the TLS SNI extension, so SNI-less clients break outright.** Java/pgJDBC tools (DBeaver, DataGrip, CLion) "do not support including a role name and password in a database connection string or URL field" — use the discrete fields. For DBeaver specifically, configure keep-alive so Neon's scale-to-zero doesn't kill the session.

| Tool | Windows install | Remote SSL to Neon | License |
|---|---|---|---|
| **pgAdmin 4** | [pgadmin.org — Windows](https://www.pgadmin.org/download/pgadmin-4-windows/) (v9.17, released 2026-07-31, signed, Win10+), or `winget install --id PostgreSQL.pgAdmin --exact` | Yes — Host `ep-….neon.tech`, Port 5432, Maintenance DB, Username, Password ([Neon — pgAdmin4 guide](https://neon.com/guides/pgAdmin4-hosted-postgres)). ⚠️ **UNVERIFIED:** which pgAdmin UI field Neon expects for SSL mode — their guide shows the connection-string params but not the UI mapping (in practice: SSL tab → SSL mode) | **Free**, open source |
| **DBeaver Community** | `winget install --id DBeaver.DBeaver.Community --exact` (id verified from [winget-pkgs](https://github.com/microsoft/winget-pkgs/tree/master/manifests/d/DBeaver/DBeaver/Community/25.0.5)). ⚠️ [dbeaver.io/download](https://dbeaver.io/download/) itself lists EXE/ZIP, Microsoft Store and `choco` — **no winget command**, so the id above comes from Microsoft's repo, not DBeaver's site | Yes, with the pgJDBC caveat + keep-alive ([Neon — DBeaver guide](https://neon.com/guides/dbeaver-hosted-postgres)) | **Free** (Community); Lite/Enterprise/Team/Ultimate are paid and are separate winget packages |
| **TablePlus** | Windows supported (.NET 4.8 required) | Yes; older versions lacking SNI need a workaround ([Neon — GUI](https://neon.com/docs/connect/connect-postgres-gui)) | **PAID** — Basic $99 (1 device) / Standard $129 (2) / Team $79 per seat. Free trial capped at **2 tabs, 2 windows, 2 advanced filters**, and advanced filters are noted unavailable on Windows ([tableplus.com — pricing](https://tableplus.com/pricing)) |
| **VS Code — PostgreSQL** | The **official one is Microsoft's**: publisher **Microsoft**, id **`ms-ossdata.vscode-pgsql`** ([VS Marketplace](https://marketplace.visualstudio.com/items?itemName=ms-ossdata.vscode-pgsql), [Microsoft Learn](https://learn.microsoft.com/en-us/azure/postgresql/development/vs-code-extension/postgresql-extension-overview)) | Yes — SSL is set in **advanced connection options** ("SSL errors: Configure SSL settings in the advanced connection options", [Microsoft Learn — quickstart connect](https://learn.microsoft.com/en-us/azure/postgresql/extensions/vs-code-extension/quickstart-connect)) | **Free** |

⚠️ Other VS Code extensions named "PostgreSQL"/"pgsql" (`doublefint.pgsql`, `STAYGELabs.lightweight-pgsql-client`, `uniquevision.vscode-plpgsql-lsp`) are **third-party**, not Microsoft. Don't install by display name alone.

### Verdict

**Primary: Neon Console → Tables.** Zero install, zero connection-string handling, zero PowerShell quoting — and it's Drizzle Studio anyway.

**Backup: `npx drizzle-kit studio`.** You need `drizzle.config.ts` for migrations regardless, so Studio costs no marginal setup, and it stays useful when the Neon console is slow or you're working offline.

**Skip psql and GUIs unless you hit something specific.** If you do need one, take **DBeaver Community** — free, winget-installable, no licence question. Avoid TablePlus for this project: it's paid, and its free trial is specifically crippled on Windows.

## D2. Is local Postgres worth it?

**Recommendation: no.** Not for a 5-day build with Neon already in the stack.

**The Docker path has a genuine unknown on this exact machine.** Docker's official system requirements, verbatim: "Windows 11 64-bit: **Enterprise, Pro, or Education** version 23H2 (build 22631) or higher" — for both the WSL 2 and Hyper-V backends ([Docker — Install on Windows](https://docs.docker.com/desktop/setup/install/windows-install/)). **This machine is Windows 11 Home Single Language**, which is not in that list. Confusingly, the *same page* elsewhere says "Windows Home or Education editions only allow you to run Linux containers" — which implies Home does work for Linux containers, and Linux containers are all Postgres needs. **UNVERIFIED: whether Docker Desktop is supported on Windows 11 Home Single Language** — Docker's own documentation contradicts itself. *Settled by: attempting the install.* That is not a coin-flip worth spending Day 1 on.

Docker Desktop **licensing** is *not* the blocker: it's free for "personal use, education, non-commercial open source projects" and for small businesses under 250 employees **and** under $10M annual revenue ([Docker — Docker Desktop license](https://docs.docker.com/subscription/desktop-license/)). A solo developer is comfortably free.

**If you want a local DB anyway**, the native install avoids the Docker question entirely and gives you a real Windows service plus pgAdmin — no WSL2, no virtualization requirement, no licensing question:

```powershell
winget install --id PostgreSQL.PostgreSQL.18 --exact
```

Or via Docker, using the [official `postgres` image](https://hub.docker.com/_/postgres). ⚠️ Note the image's own volume-path rule — **`/var/lib/postgresql` for 18+, `/var/lib/postgresql/data` for 17 and earlier** — and that `POSTGRES_PASSWORD` "must not be empty or undefined":

```powershell
docker run -d --name callzie-pg `
  -e POSTGRES_PASSWORD=devpassword `
  -e POSTGRES_DB=callzie `
  -p 5432:5432 `
  -v callzie-pgdata:/var/lib/postgresql `
  postgres:18
```

Then `DATABASE_URL=postgresql://postgres:devpassword@localhost:5432/callzie`.

**The better answer is Neon branches.** SPEC.md's Free plan gives you **10 branches per project** (B1). A branch is a copy-on-write database created in seconds, costing no extra storage for unchanged data — which is precisely the "throwaway DB to test a migration against" use case that would otherwise justify local Postgres. You get it without Docker, without a second connection-string dialect, and without the Windows-edition question. Use a `dev` branch for development and keep `main` clean; if you take the Vercel-Managed integration (B3), you also get a branch per Preview Deployment automatically.

### Running migrations against two databases

**`--config` is officially supported.** Verbatim: "Use the `--config` flag to specify different config files… useful for managing multiple databases or deployment stages within a single project", with the documented example `npx drizzle-kit generate --config=drizzle-dev.config.ts` ([Drizzle — drizzle.config.ts](https://orm.drizzle.team/docs/drizzle-config-file)). The flag is listed on `generate`, on `migrate` ("specify a custom config file, useful for multiple database stages"), and on `push`. Default is `drizzle.config.ts`.

```powershell
# A) Two config files
npx drizzle-kit migrate --config=drizzle-local.config.ts
npx drizzle-kit migrate --config=drizzle-neon.config.ts

# B) One config, env-var switching  (PowerShell has NO inline `VAR=x cmd` prefix)
$env:DATABASE_URL_DIRECT='postgresql://postgres:devpassword@localhost:5432/callzie'
npx drizzle-kit migrate
```

Option B works because the documented config reads `url: process.env...!`. **Prefer B** — one config file, one source of truth, and it matches how Vercel injects the URL in production. ⚠️ `$env:VAR = '...'` is per-shell-session and does **not** persist across separate tool invocations or new terminals.

---

---

# E. Google Calendar (SPEC.md §13 item 4, issue #20, ADR-0004)

**Fetched: 2026-08-23**, before writing any payload, per SPEC.md §3 rule 12.

## E1. SPEC.md §13 item 4 — ANSWERED

**"The exact test-user cap for a Google OAuth app in Testing status."**

**100 test users**, and — the part the question did not ask, which matters more —
**the refresh token expires after seven days.**

> "Projects configured with a publishing status of `Testing` are limited to up to
> 100 test users listed in the OAuth consent screen. A test user consumes a
> project's test user quota once added to the project."
> — [Manage App Audience](https://support.google.com/cloud/answer/15549945)

> "A Google Cloud Platform project with an OAuth consent screen configured for an
> external user type and a publishing status of 'Testing' is issued a **refresh
> token expiring in 7 days**, unless the only OAuth scopes requested are a subset
> of name, email address, and user profile (through the `userinfo.email,
> userinfo.profile, openid` scopes, or their OpenID Connect equivalents)."
> — [Using OAuth 2.0 to Access Google APIs](https://developers.google.com/identity/protocols/oauth2)

`calendar.events` is not in that exempt subset, so **it applies to Callzie**. A
connected Business loses its calendar after a week and must reconnect.

This is a consequence of ADR-0004's decision to ship in Testing status rather
than wait weeks for verification, so it is a designed state rather than a fault.
`lib/google/token.ts` treats the resulting `invalid_grant` exactly like a
revocation — both mean "reconnect" — and stamps `businesses.google_access_lost_at`
so `/settings` can say so. The column is not called `google_revoked_at` for this
reason.

Leaving Testing means OAuth verification, because the scope is **sensitive**:

> "Examples of sensitive scopes include reading events stored in Google Calendar"
> — [Sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)

It is **not restricted** — the restricted list contains only Gmail, Drive and Fit
([Restricted Scopes](https://support.google.com/cloud/answer/13464325)) — so no
third-party security assessment would be required, only verification.

## E2. The API facts the push is built on

| Fact | Source |
|---|---|
| `timeMin` — "Lower bound (**exclusive**) for an event's **end** time to filter by." RFC3339 with "mandatory time zone offset" | [events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list) |
| `timeMax` — "Upper bound (**exclusive**) for an event's **start** time to filter by." | same |
| `singleEvents` — expands recurring events into instances. **Default `false`** | same |
| `showDeleted` — includes `cancelled` events. **Default `false`** | same |
| `maxResults` — "By default the value is 250 events. The page size can never be larger than 2500 events." | same |
| `transparency` — "`opaque` - **Default value.** The event does block time... `transparent` - The event does not block time" | [Events resource](https://developers.google.com/workspace/calendar/api/v3/reference/events) |
| `status` — `confirmed` (default), `tentative`, `cancelled` | same |
| All-day shape — `start.date` `"yyyy-mm-dd"`; timed events use `start.dateTime`. `end.date` is **exclusive** | same |
| `events.insert` — `POST .../calendars/{calendarId}/events`. Only **two** required properties: `start` and `end` | [events.insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert) |
| `events.patch` — "Fields that you don't specify in the request remain unchanged." Costs **three quota units**; Google suggests `get` + `update` at two | [events.patch](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch) |
| `events.delete` — already deleted returns **410**, reason `deleted`: "For already deleted events, no further action is necessary." Never existed returns **404** | [Errors](https://developers.google.com/workspace/calendar/api/guides/errors) |
| Refresh — `POST https://oauth2.googleapis.com/token`, form-encoded, `grant_type=refresh_token` + `refresh_token` + `client_id` + `client_secret` | [Web server flow](https://developers.google.com/identity/protocols/oauth2/web-server) |
| Refresh response — `access_token`, `expires_in`, `scope`, `token_type`. A `refresh_token` appears **only** if `access_type=offline` was set on the original request | same |
| `invalid_grant` — "the token may have expired or has been invalidated. Authenticate the user again." Carries an `error_subtype` separating revocation from a session policy | same |
| Refresh-token cap — "a limit of 100 refresh tokens per Google Account per OAuth 2.0 client ID... creating a new refresh token automatically invalidates the oldest" | [OAuth 2.0](https://developers.google.com/identity/protocols/oauth2) |

**The `timeMin`/`timeMax` pair is the most useful fact here.** Each bound is
compared against the *opposite* end of the event, which is exactly the half-open
overlap test — so one wide request provably cannot miss anything that overlaps
any part of the window. Both bounds being exclusive also means an event that
merely touches the boundary is not returned, which is the right answer for
back-to-back bookings.

## E3. UNVERIFIED — all-day events under a partial-day window

**Google publishes no statement about how a date-only event is compared against
`timeMin`/`timeMax`.** The parameter docs describe the filter purely in terms of
an event's start and end time and say nothing about how `"2026-08-25"` becomes an
instant. Midnight in the calendar's zone is the obvious guess and is not
documented.

This matters because Callzie treats an all-day event as a Collision by decision:
if the owner blocked the whole day out, every Appointment in it is a problem.

**The code does not depend on the answer.** `lib/google/overlap.ts` always
queries whole local days, so an all-day event is unambiguously inside the window
however Google resolves it, and the overlap comparison is done in our own code.

*Settled by:* `npm run try-google`, step 5, which inserts a real all-day event and
queries a partial-day window against a real calendar. Record the observed answer
here when it has been run.

## E4. UNVERIFIED — smaller ones

- **The success status code for `events.delete`.** Documented only as "an empty
  response body". `lib/google/events.ts` treats any 2xx, plus 404 and 410, as
  success, so the exact number is not load-bearing.
- **The `invalid_grant` body shape for the refresh grant specifically.** The 400
  status and the `error` field are documented for the same token endpoint under
  the device grant, not the refresh grant. Matching on `error === "invalid_grant"`
  is the safe read.

---

# Watch-outs

Things that will bite during the build, roughly in the order you'll hit them.

### Day 1 — the two things that can end the project

1. **The India contradiction (A2).** Retell's docs say both "India, $0.15/min" and "numbers purchased from Retell can only make calls to US numbers." **Do the manual dashboard call to your own +91 number in the first hour**, before writing code. That one ~$0.25 call resolves the §11 kill switch. Watch for `invalid_destination` / `telephony_provider_permission_denied` / `dial_failed`.
2. **KYC gates outbound calling entirely (A1).** Not just number purchase — *outbound calling*. If you're routed to manual review ("proof you represent the company"), you are blocked for an unknown period. **Trigger KYC on Day 1 morning, not Day 2.** If it stalls, invoke §13 immediately rather than waiting.

### Money

3. **~$0.25/min to India means ~30 minutes total, ever.** The $10 credit minus $2/mo for the number is roughly 16 calls at the 120 s cap SPEC.md §7 settled on. Set `max_call_duration_ms: 120_000` **in the agent config** — a prompt instruction ("end the call within two minutes") is a suggestion; the config field is a hard stop. Note the config default is **1 hour**, so leaving it unset is the expensive mistake.
4. **Dynamic opening messages force a 10-second billing minimum** ([Retell — Billing exceptions](https://docs.retellai.com/accounts/billing-exceptions)). Set `begin_message` explicitly so you don't pay 10 s for every unanswered ring.
5. **`no_valid_payment` means the credit is gone.** Surface it as a distinct, loud UI state — not a generic `failed`. Discovering mid-demo that you're out of credit is the worst possible time.
6. **Never enable burst mode** — "$0.10/min surcharge applied to the entire call duration" would ~40% inflate every India call, for a concurrency ceiling you'll never approach.

### Correctness traps that fail silently

7. **`Retell.verify()` is async.** `if (!Retell.verify(...))` is a *always-false* negation of a Promise — **your webhook would accept forged payloads and you'd never notice**. `await` it. (A8)
8. **The payload key is `disconnection_reason`, not `disconnect_reason`.** Reading the wrong one yields `undefined` and maps every call to `failed`. (A9)
9. **Raw body only.** `await request.text()` then `JSON.parse` yourself. Calling `request.json()` first makes signature verification fail 100% of the time, and the error looks like a bad secret. (A8)
10. **`retell_llm_dynamic_variables` values must all be strings.** `scheduled_at` is a `timestamptz` — format it before sending, or the call fails. (A5)
11. **Unset dynamic variables render literally.** A plumbing bug means Maya says "Hello curly-curly-name" *on the demo call*. Validate before dialling. (A5)
12. **Agent-level webhooks override account-level ones** — they don't stack. If you set an account webhook while testing in the dashboard, it goes silent the moment the agent has its own `webhook_url`. (A7)
13. **`RETELL_WEBHOOK_SECRET` and `RETELL_API_KEY` hold the same value.** Retell signs with the API key flagged as webhook key; there is no separate secret. Two env var names, one string. (A8)
14. **Use the pooled `-pooler` URL for the app and the direct URL for `drizzle-kit`.** Running migrations through PgBouncer's transaction mode fails in non-obvious ways. Define two env vars from Day 1 — retrofitting this after a confusing migration failure is worse. (B2)

### Timing and ordering

15. **`call_ended` explicitly excludes `call_analysis`.** The summary, `in_voicemail`, and sentiment only arrive on `call_analyzed`. §6's "treat as the transcript source if the ended event lacks one" instinct is right — extend the same defensiveness to `recording_url`, whose arrival event is **UNVERIFIED**. Upsert on both events, take whichever is non-null. (A9)
16. **Retries are real: 10 s timeout, up to 3 attempts.** §3's idempotency rule isn't theoretical hygiene — you will observe duplicates. Test the duplicate-delivery fixture properly. (A7)
17. **The signature has a 5-minute replay window.** `scripts/replay-webhook.ts` must sign with `Date.now()`, not a timestamp baked into the fixture — otherwise your whole replay suite starts failing the moment fixtures age. Use the SDK's exported `sign()`. (A8)
18. **The `call_ended` → `call_analyzed` delay is UNVERIFIED.** Don't build §6 to assume a window. Handle either arriving first.

### Demo day

19. **Cold starts stack.** Vercel + Neon (5-min autosuspend, "a few hundred ms", longer after 7 days idle) both wake on the first request. **Click the dashboard ~30 s before you start talking.** (B1)
20. **Vercel Hobby retains runtime logs for 1 hour.** If a demo call misbehaves and you investigate the next morning, the logs are gone. Persist what you need — which `webhook_events.payload` already does. That table is your log retention. (C3)
21. **Neon storage overage fails writes rather than billing you.** A runaway test loop → failed writes → 500s into Retell's retry loop. (B1)

### Scope and claims

22. **Keep the deployed site free of any pricing/payment/"sign up for $X" surface** — that's what would flip Vercel Hobby's commercial-use clause. The spec's three-screen scope already complies; don't add a marketing page. (C3)
23. **Don't claim India regulatory compliance.** Retell's docs say nothing about TRAI/DLT/TCPA, and I could not verify it from any primary source. Calling your own and consenting friends' phones for a demo is fine; say plainly in the README that production use in India would need a compliance review. It's a stronger answer in an interview than pretending the question doesn't exist. (A2)
24. **Don't claim "max 3 concurrent" is a platform limit.** The free quota is 20. It's cost control and demo pacing — say so. (A10)
25. **`push` vs `generate`+`migrate`.** SPEC.md §2 requires migrations checked into the repo. `push` is fine while iterating on Day 1, but the committed artifact must be generated migrations. (D1)
26. **A custom Tool's `timeout_ms` defaults to 120,000 ms — your entire call.** One stalled Tool consumes the whole conversation and bills for it, and the caller just hears silence. Set it explicitly on every Tool; Callzie uses 10,000. (A12)
27. **Never run `create-agent` while `APP_URL` is `localhost`.** The Tool URLs and webhook URL are baked into the Agent at creation time and Retell calls them from its own servers, so you get four Agents that connect fine and fail every Tool call. It surfaces mid-demo as Maya stalling, not as an error at creation. `scripts/create-agent.ts` refuses unless `--allow-localhost` is passed. (A12)
28. **Re-run `create-agent` after anything changes `APP_URL` or `INTERNAL_SECRET`.** Both are baked in. A rotated secret silently breaks every Tool call on every Agent until the script is re-run. (A12)
29. **Without an `end_call` tool the Agent physically cannot hang up.** SPEC.md §7's prompt says "end the call" in four branches; if `general_tools` omits Retell's built-in `end_call`, every Call runs to the 120 s cap and bills for it. This is why `general_tools` has five entries while `TOOL_NAMES` has four. (A12)
30. **`npm run <script> -- --flag` does not pass `--flag` to the script.** Verified against npm 11.16.0 on 2026-08-13: npm strips every `--flag` from the arguments after `--`, sets `npm_config_<flag_with_underscores>` instead, and hands the script an *empty* `argv` — printing `npm warn Unknown cli config` only for names it does not already know, and nothing at all for ones it does (`--dry-run`, `--offline`, `--only`). Observed live: `npm run create-agents -- --dry-run` provisioned four real Agents. Any script invoked through npm must read `npm_config_*` as well as `argv` — `lib/retell/flags.ts` does, with regression tests. A default that mutates something is what turns this into damage rather than an inconvenience.
31. **A Google connection made while the app is in Testing status dies after seven days.** Not a bug and not a Callzie failure: Google issues a 7-day refresh token to any external Testing-status app requesting a sensitive scope, and `calendar.events` is one. It surfaces as `invalid_grant` on the next push, with nobody watching. Callzie clears the connection and stamps `google_access_lost_at` so `/settings` explains it, and the owner reconnects. (E1)
32. **`singleEvents` defaults to `false` on `events.list`.** Left at the default, a weekly recurring meeting comes back as the recurrence *rule* rather than this week's instance, so its times are meaningless and the slot it really occupies is missed. Collision detection would look like it worked and find nothing. `lib/google/events.ts` sets it explicitly. (E2)
33. **`transparency` is absent on most real events.** `opaque` is Google's default, so a test for `!== "opaque"` ignores nearly everything on a real calendar. The test must be that only an explicit `transparent` is skipped. Same failure mode as 32: quiet, and looks like it works. (E2)
34. **Google Calendar accepts overlapping events without complaint.** `events.insert` reports no conflict, so a successful write says nothing about whether the time was free. Detection is a deliberate second read (ADR-0004), which is why Callzie can only ever detect a Collision after the fact and never prevent one.

### Inbound (issues #43, #44)

35. **⚠️ UNVERIFIED, and blocking: how the inbound webhook proves it came from Retell.** The inbound-call-webhook page says to "verify the webhook using your Retell API key" without naming the header or the construction, and it is not stated to be the same `X-Retell-Signature` flow A8 records for call events. `app/api/webhooks/retell/inbound/route.ts` **assumes it is, and fails closed** — if the assumption is wrong, every inbound call is refused until somebody looks. That is the deliberate choice: the alternative is an endpoint which, given a phone number, reveals which Business owns it and how it is configured, enumerable by anyone with a list of numbers. **Settle this against one real inbound call before pointing a real number at a real business.**
36. **The inbound webhook has a 10-second timeout and up to 3 retries.** Verified from the docs on 2026-08-26. The reply decides whether anybody is connected at all, so unlike the call webhook there is no "return 200 fast and process later" escape — the answer *is* the work. `lib/inbound/answer.ts` is a small number of indexed reads and nothing else, and the route turns any exception into a rejection rather than letting it escape, because inside that window an unhandled error is silence on the line.
37. **`reject` wins over agent selection in the reply.** `override_agent_id` and `agent_override` are ignored when `reject` is true. So a reply must never carry both — a stray `reject` alongside a valid agent id silently declines every call while the rest of the response looks perfectly correct. `lib/inbound/payload.test.ts` pins both directions.
38. **The same URL receives `sms_inbound`.** Retell's inbound webhook covers text messages as well as calls. Answering one with an agent id is Callzie claiming to have handled something it has not, so `parseInboundCall` checks the event name and the route declines — with a 200, not a 400, because a 400 would be retried three times.
39. **UNVERIFIED: whether `override_agent_id` is honoured when the number already has an agent bound to it.** Callzie sets an agent on the number at purchase time *and* overrides per call. If the override loses, every caller reaches whichever Agent was bound at purchase — which for a Business that changed its Business Type is the wrong persona, and nothing errors.
40. **UNVERIFIED: what Retell does with a malformed response.** Reject the call, or fall through to the number's configured agent? This decides whether a Callzie bug is a declined call or a call answered by an Agent with no dynamic variables, reading `{{business_name}}` aloud.
41. **A purchased number bills about $2/month whether or not it rings**, and nothing stops it. This is the first per-tenant recurring cost in the product. It is why provisioning is `npm run provision-number` rather than a button (Callzie is open signup), and why `lib/inbound/provision.ts` reports an orphaned number loudly instead of trying to auto-release one: a release that itself fails leaves nothing anywhere pointing at a line that bills forever.
42. **UNVERIFIED: KYC for holding many numbers on one Retell account.** A1 records the single-number path. Whether a workspace holding one number per tenant lands somewhere different is unknown, and it is on the path to any real multi-tenant use of #44.
43. **Forwarding codes (`*72`, `*71`, `*73`) are conventions, not a standard.** Right often enough to try first, wrong often enough that they must not be promised — VoIP systems ignore them entirely and want the change made in their web console. `docs/runbooks/inbound-forwarding.md` says so, and insists on one real test call as proof, because a forwarding rule that silently did not apply looks exactly like one that did.
