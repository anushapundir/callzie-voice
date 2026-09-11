import {
  BUSINESS_TYPES,
  INBOUND_TOOL_NAMES,
  OUTBOUND_TOOL_NAMES,
  type BusinessType,
  type CallDirection,
  type ToolName,
} from "@/lib/db/schema";

/*
  The four Templates (SPEC.md §4) — one per Business Type, curated by us. Users
  never author a prompt (SPEC.md §14 rule 5), so this file is the whole of what
  Maya is told, for every account on the platform.

  SPEC.md §7 gives the prompt verbatim for the clinic and says: "vary the persona
  and the service noun, not the structure". So there is exactly one copy of the
  structure, with three holes. lib/retell/templates.test.ts proves nothing else
  varies, by rendering all four with identical sentinel deltas and asserting the
  results are byte-identical.

  Like lib/retell/tools.ts this stays dependency-free — plain data and pure
  functions, importable from both a Node script and a route handler.
*/

/**
 * The voice Maya speaks in, shared by all four Templates.
 *
 * CONTEXT.md names one Agent — Maya — so she sounds the same whichever Business
 * Type is calling; only her words change. The field lives on the Template rather
 * than as a bare constant so giving one vertical its own voice later is a
 * one-line change.
 *
 * Verified against the live workspace on 2026-08-13 via `--list-voices`:
 * American, female, middle-aged, ElevenLabs. Female because every begin message
 * and prompt says "this is Maya calling" — the first configuration used
 * `11labs-Adrian`, which Retell accepts happily and which introduced itself as
 * Maya in a young male voice. Nothing errors; the caller simply hears the
 * mismatch. Middle-aged over young because these are confirmation calls on a
 * business's behalf.
 *
 * ⚠️ Voice ids are workspace-visible, so this is not portable to another Retell
 * account by assumption. Re-check with `--list-voices` there; an unknown id is
 * rejected at create time, but a *wrong* id is not.
 */
const MAYA_VOICE_ID = "11labs-Merritt";

export type Template = {
  businessType: BusinessType;
  /**
   * Which way this Agent's Calls go (issue #43).
   *
   * There are eight Agents now, not four: each Business Type has one that calls
   * out about an Appointment and one that answers the phone. They differ in
   * prompt, Tool set and call cap, so everything that provisions or resolves an
   * Agent has to know which it is holding.
   */
  direction: CallDirection;
  /** Dashboard-visible, and the idempotency key — see lib/retell/reconcile.ts. */
  agentName: string;
  /** What kind of place Maya says she is calling on behalf of. */
  businessNoun: string;
  /** What the booking is called out loud, after the {{service}} variable. */
  serviceNoun: string;
  /** This vertical's instance of SPEC.md §14 rule 8 — never invent detail. */
  inventionGuard: string;
  /**
   * The first utterance, verbatim.
   *
   * MUST be set: an unset begin_message makes Retell generate the opening
   * dynamically, which triggers the 10-second billing minimum
   * (docs/verification.md A4).
   */
  beginMessage: string;
  voiceId: string;
};

/**
 * The idempotency key, derived rather than hand-written.
 *
 * Machine-stable first — the script matches on it to decide create-versus-update
 * — but still legible in the Retell dashboard. Retell constrains agent names to
 * [a-zA-Z0-9_-] with no spaces, which `business_type` already satisfies.
 */
export function agentNameFor(businessType: BusinessType): string {
  return `callzie-${businessType}`;
}

/**
 * The inbound Agent's name — the same idempotency key, in the other direction.
 *
 * A separate Agent rather than a mode of the one above. They differ in prompt,
 * in Tool set and in call cap, and `retell_agents` is keyed by
 * (business_type, direction) so the reconcile pass can tell them apart.
 */
export function inboundAgentNameFor(businessType: BusinessType): string {
  return `callzie-inbound-${businessType}`;
}

/** Everything that varies between the four Templates. Nothing else may. */
const DELTAS: Record<
  BusinessType,
  Pick<
    Template,
    "businessNoun" | "serviceNoun" | "inventionGuard" | "beginMessage"
  >
> = {
  clinic: {
    businessNoun: "clinic",
    serviceNoun: "appointment",
    inventionGuard:
      "Never give medical advice and never invent clinical details.",
    beginMessage:
      "Hi, this is Maya calling from the clinic about your upcoming appointment.",
  },
  salon: {
    businessNoun: "salon",
    serviceNoun: "appointment",
    inventionGuard:
      "Never quote a price and never invent a stylist's availability.",
    beginMessage:
      "Hi, this is Maya calling from the salon about your upcoming appointment.",
  },
  home_services: {
    businessNoun: "home services company",
    serviceNoun: "visit",
    inventionGuard:
      "Never quote a price and never promise a specific technician.",
    beginMessage:
      "Hi, this is Maya calling about your upcoming home visit.",
  },
  tutoring: {
    businessNoun: "tutoring centre",
    serviceNoun: "session",
    inventionGuard:
      "Never discuss a student's progress, grades or fees.",
    beginMessage:
      "Hi, this is Maya calling about your upcoming tutoring session.",
  },
};

/*
  Built by mapping over BUSINESS_TYPES rather than by listing four objects, so
  this can never drift from the union the database enforces. DELTAS being a
  Record<BusinessType, …> means adding a fifth Business Type is a compile error
  until its Template exists.
*/
export const TEMPLATES: readonly Template[] = BUSINESS_TYPES.map(
  (businessType) => ({
    businessType,
    direction: "outbound" as const,
    agentName: agentNameFor(businessType),
    voiceId: MAYA_VOICE_ID,
    ...DELTAS[businessType],
  }),
);

/**
 * The inbound half — one per Business Type (issue #43).
 *
 * Derived from `TEMPLATES` rather than listed separately, so the two can never
 * drift on the things they genuinely share: the voice, the business noun, and
 * the vertical's invention guard. Only what must differ does — the name, the
 * direction and the opening line.
 */
export const INBOUND_TEMPLATES: readonly Template[] = TEMPLATES.map(
  (template) => ({
    ...template,
    direction: "inbound" as const,
    agentName: inboundAgentNameFor(template.businessType),
    beginMessage: inboundBeginMessage(),
  }),
);

/** Everything `scripts/create-agent.ts` provisions: eight Agents, not four. */
export const ALL_TEMPLATES: readonly Template[] = [
  ...TEMPLATES,
  ...INBOUND_TEMPLATES,
];

export function templateFor(
  businessType: BusinessType,
  direction: CallDirection = "outbound",
): Template {
  const template = ALL_TEMPLATES.find(
    (t) => t.businessType === businessType && t.direction === direction,
  );

  if (!template) {
    throw new Error(
      `No ${direction} Template for business type '${businessType}'.`,
    );
  }

  return template;
}

/**
 * This Template's prompt, whichever direction it faces.
 *
 * One place that dispatches, so no caller has to remember which builder goes
 * with which Agent. Handing an inbound Agent the outbound prompt would have it
 * open a call to a stranger by asking whether Tuesday still works.
 */
export function promptFor(template: Template): string {
  return template.direction === "inbound"
    ? buildInboundPrompt(template)
    : buildPrompt(template);
}

/** The Tools this Template's Agent is armed with. */
export function toolNamesFor(template: Template): readonly ToolName[] {
  return template.direction === "inbound"
    ? INBOUND_TOOL_NAMES
    : OUTBOUND_TOOL_NAMES;
}

/** The hard cap this Template's Calls run under, in milliseconds. */
export function maxCallDurationFor(template: Template): number {
  return template.direction === "inbound"
    ? INBOUND_MAX_CALL_DURATION_MS
    : OUTBOUND_MAX_CALL_DURATION_MS;
}

/**
 * The outbound cap, restated here so both live side by side.
 *
 * SPEC.md §7: raised from 90s, then from 120s after a real Call was cut off
 * mid-booking. The primary cost guardrail, enforced in config and never in the
 * prompt (SPEC.md §3 rule 6).
 */
export const OUTBOUND_MAX_CALL_DURATION_MS = 180_000;

/**
 * The prompt, from SPEC.md §7, with this Template's three deltas filled in.
 *
 * Two clauses here are not in §7's text, both applied identically to all four so
 * the structure stays single-copy:
 *
 * - "pass slot_start exactly as check_availability returned it" — enforces the
 *   opaque-token contract in lib/retell/tools.ts, which is what lets the endpoint
 *   verify server-side that a booked Slot was genuinely Offered.
 * - the trailing inventionGuard — the per-vertical instance of SPEC.md §14
 *   rule 8. A4's own sample prompt does the same thing.
 * - the empty-Availability branch in step 3 — check_availability can return
 *   nothing, either because the fortnight is full or because this Call has
 *   already worked through it (lib/tools/check-availability.ts), and an
 *   unguided model fills that silence by inventing a time.
 * - "when a tool's answer includes a say value, use those words" — the
 *   prompt-side half of lib/tools/say.ts. It is a suggestion, which is exactly
 *   why the tool response is written to be unreadable as a success on its own.
 * - **"call book_slot straight away… say nothing about the booking until it has
 *   answered"** — added after a live Call on 2026-08-21 in which Maya said "I'll
 *   book Monday at 12:30, I'm placing a hold for that time now" and the customer
 *   hung up before `book_slot` was ever invoked. Nothing was written and nobody
 *   was told. Announcing an intention is indistinguishable, to the person on the
 *   phone, from announcing a result — so she is told not to narrate the write at
 *   all. The `book_slot` filler in lib/retell/tools.ts covers that silence with a
 *   request to hold, which promises effort rather than an outcome.
 *
 * Note what is NOT here: Business Hours, and any turn or time limit. Both are
 * enforced in config and in the Tool, never in the prompt, because a prompt
 * instruction is a suggestion (SPEC.md §3 rule 6, ADR-0003).
 */
export function buildPrompt(template: Template): string {
  return `You are Maya, a friendly scheduling assistant calling on behalf of {{business_name}}, a ${template.businessNoun}.
You are speaking with {{name}} about their {{service}} ${template.serviceNoun} on {{time}}.

Goal: confirm whether they can attend, and rebook them if they cannot.
1. Greet them by name, say why you're calling, ask if {{time}} still works.
2. If yes: call confirm_appointment, tell them it's locked in, end the call.
3. If no: call check_availability, offer the times it returns. If they reject them,
   ask what would suit and call check_availability again. Repeat until one works.
   The moment they accept a time, call book_slot straight away. Do not say you are
   booking it, holding it or locking it in first — say nothing about the booking
   until book_slot has answered, then tell them what it says. If check_availability
   returns no times at all, tell them so, say someone will call them back, and end
   the call.
4. If they want to cancel entirely: call cancel_appointment, acknowledge, end the call.
5. If it's clearly a wrong number or voicemail: apologise briefly and end the call.

Rules: keep every reply under 2 sentences. Only ever offer times that
check_availability returned — never invent one. When you call book_slot, pass
slot_start exactly as check_availability returned it. When a tool's answer
includes a say value, use those words. If book_slot fails, say you'll have
someone call back to confirm; never say the booking is done. Never discuss
anything except this appointment. Never invent personal details.
${template.inventionGuard}`;
}

/**
 * The dynamic variables every prompt expects at call time.
 *
 * Retell renders an unset variable literally — a plumbing bug means Maya says
 * "curly-curly-name" to a customer (docs/verification.md A5) — so the Web Call
 * path validates against this list before dialling. `first_name` is deliberately
 * absent: it is reserved and auto-populates from Retell Contacts.
 */
export const PROMPT_VARIABLES = [
  "business_name",
  "name",
  "service",
  "time",
] as const;

/**
 * The inbound prompt's variables (issue #43).
 *
 * A different set, because a different situation. Outbound knows who it is
 * calling and why; inbound knows nothing about the caller and everything about
 * the business — which is the whole asymmetry of the feature.
 *
 * `services_list` is the load-bearing one. It is the entirety of what Maya knows
 * about what the business does: there is no knowledge base behind her, so every
 * service she can name came out of the `services` table. That is what makes
 * "never invent a service" enforceable rather than hopeful.
 */
export const INBOUND_PROMPT_VARIABLES = [
  "business_name",
  "services_list",
  "is_open_now",
  "hours_today",
  "next_open",
  "local_time",
  "emergency_line",
] as const;

/**
 * How long an inbound Call may run.
 *
 * 300 seconds against the outbound 180. An enquiry followed by a booking is
 * genuinely a longer conversation than a confirmation — the caller has to say
 * what they want, hear what is free, choose, and give a name and a number — and
 * 180s cut a real booking off mid-negotiation once already (SPEC.md §7).
 *
 * Still a hard cap, still in config and never in the prompt (SPEC.md §3 rule 6).
 */
export const INBOUND_MAX_CALL_DURATION_MS = 300_000;

/**
 * What Maya says when she picks up.
 *
 * MUST be set, for the same billing reason as the outbound one: an unset
 * `begin_message` makes Retell generate the opening dynamically, which triggers
 * the 10-second billing minimum (docs/verification.md A4).
 *
 * Deliberately does not name the business type. "Thanks for calling {{business_
 * name}}" works whether the caller reached a clinic or a salon, and the name is
 * the thing that tells them they dialled correctly.
 */
export function inboundBeginMessage(): string {
  return "Thanks for calling {{business_name}}. This is Maya, an AI assistant. How can I help?";
}

/**
 * The inbound prompt.
 *
 * Structured like `buildPrompt` above — numbered branches, then a rules block —
 * so the two read the same way, and varying only `businessNoun` and
 * `inventionGuard`. `serviceNoun` is deliberately unused: an inbound caller has
 * not got an appointment yet, so there is no noun for one.
 *
 * Three things here are worth reading slowly, because each exists in response to
 * a way this feature can hurt somebody:
 *
 * **The emergency branch is first.** An always-on clinic line receives "I'm in a
 * lot of pain, what should I do?" in its first week. It is first in the prompt
 * because ordering is the cheapest instruction an LLM follows, and because
 * everything else on the call is worthless if this is got wrong. SPEC.md §14
 * rule 10. Note it is also the only branch that ends the call without logging an
 * enquiry first — the caller needs the number now, not after a Tool round trip.
 *
 * **Name and number are collected before `book_appointment`, not after.** Rule
 * 11: a Slot held for somebody unreachable is worse than an empty Slot, because
 * it blocks a real booking and nobody can undo it. The Tool refuses without
 * them, so this is the prompt half of a rule the endpoint enforces.
 *
 * **She is told not to narrate the write.** Identical wording to the outbound
 * prompt, and for the identical reason: a live Call on 2026-08-21 ended with
 * Maya saying "I'm placing a hold for that time now" and the customer hanging up
 * before the Tool was ever invoked. Announcing an intention is indistinguishable,
 * to the person on the phone, from announcing a result.
 */
export function buildInboundPrompt(template: Template): string {
  return `You are Maya, an AI assistant answering the phone for {{business_name}}, a ${template.businessNoun}.
You do not know who is calling. Find out what they need and help them.

What you know about {{business_name}}:
- Services offered: {{services_list}}
- Open right now: {{is_open_now}}
- Today's hours: {{hours_today}}
- Next open: {{next_open}}
- The local time is {{local_time}}

1. If they describe a medical, safety or legal emergency, or say they are in
   pain or in danger: tell them this line cannot help with that, give them
   {{emergency_line}}, and end the call. Do this before anything else.
2. If they ask what you offer, what it costs to wait, or when you are open:
   answer from the list above. Never name a service that is not on it.
3. If they want an appointment: ask which service, then call check_availability
   and offer the times it returns. If they reject them, ask what would suit and
   call check_availability again. Once they accept a time, ask for their full
   name and a number to reach them on, and read the number back. Only then call
   book_appointment. Do not say you are booking, holding or locking anything in
   first — say nothing about the booking until book_appointment has answered,
   then tell them what it says.
4. If they ask about an appointment they already have: call lookup_appointment.
   If it returns nothing, say you cannot find one for this number and offer to
   take a message. Never guess that they have one.
5. If they are unhappy, want somebody to ring them back, or you could not help:
   call log_enquiry so a person at the business sees it, then say somebody will
   get back to them.
6. Before you end any call that did not end in a booking, call log_enquiry.

Rules: keep every reply under 2 sentences. Only ever offer times that
check_availability returned — never invent one. When you call book_appointment,
pass slot_start exactly as check_availability returned it. When a tool's answer
includes a say value, use those words. If book_appointment fails, say you will
have someone call back to confirm; never say the booking is done. Never quote a
price and never say whether anything is covered by insurance. Never take card or
payment details. Never promise that somebody will call back at a specific time.
Never discuss anything except this business and this caller's request.
${template.inventionGuard}`;
}

/**
 * A deliberate over-estimate of prompt tokens, not a tokenizer.
 *
 * The budget that matters is Retell's long-prompt billing scaler: an agent over
 * 4,000 tokens has "Scaling Factor = Prompt LLM Tokens ÷ 4,000" applied to its
 * billed duration (docs/verification.md A2). The rule of thumb for English is
 * ~4 characters per token; dividing by 3 is comfortably pessimistic for prose and
 * JSON alike. Callzie's real figure is a few hundred, so with a 10x margin
 * exactness is worthless and a tokenizer dependency — whose encoding for
 * gpt-5-nano we could not verify from a primary source anyway — is pure cost.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}
