import { OUTBOUND_TOOL_NAMES, type ToolName } from "@/lib/db/schema";

/*
  The four Callzie Tools as Retell sees them (SPEC.md §7, ADR-0003).

  This module is the two-sided contract between the Agent and the endpoints that
  serve it: issue #9 declares these schemas on the Retell LLM, issue #10 implements
  the routes at TOOL_PATHS. Both import from here, so a renamed argument is a
  compile error rather than a mid-call hallucination.

  Deliberately dependency-free: no `server-only`, no `retell-sdk`, and no env reads
  at module scope, because a plain Node script (scripts/create-agent.ts) and a Next
  route handler both import it. APP_URL and INTERNAL_SECRET arrive as arguments.

  Field shapes and defaults below were read off retell-sdk@5.62.0's own type
  declarations rather than the prose docs, which contradict themselves on two of
  them — see docs/verification.md A12.
*/

/** A JSON Schema object as Retell's `parameters` field accepts it. */
export type ToolParameters = {
  // Retell requires the root to be "object". Omitting it is the documented
  // common mistake, and it fails at call time rather than at creation time.
  type: "object";
  properties: Record<string, { type: "string"; description: string }>;
  // Every member must exist in `properties`; lib/retell/tools.test.ts asserts it.
  required: string[];
};

/**
 * The subset of Retell's custom-tool shape Callzie uses.
 *
 * Declared here rather than imported from `retell-sdk` so this module stays
 * importable from a route handler without pulling the SDK into the bundle.
 * `scripts/create-agent.ts` assigns the result to the SDK's own parameter type,
 * so `npm run typecheck` still proves the two agree.
 */
export type CallzieCustomTool = {
  type: "custom";
  name: ToolName;
  description: string;
  url: string;
  method: "POST";
  headers: Record<string, string>;
  parameters: ToolParameters;
  speak_during_execution: boolean;
  speak_after_execution: boolean;
  execution_message_type?: "prompt" | "static_text";
  execution_message_description?: string;
  timeout_ms: number;
};

/**
 * A Tool may run this long before Retell gives up on it.
 *
 * Retell's default is 120,000 ms — most of Callzie's entire call cap
 * (SPEC.md §7), so one stalled Tool would consume the whole conversation. The
 * budget that matters is the caller's patience, not the API's: past a couple of
 * seconds the line is just silent. 10s is generous for a single Postgres query
 * and still leaves the 180s cap meaning what it says.
 */
const TOOL_TIMEOUT_MS = 10_000;

/**
 * Where each Tool is served.
 *
 * Issue #10 builds these routes and its ticket does not fix the paths, so they are
 * chosen here. Kebab-case because that is the Next.js route-segment convention;
 * the Tool *names* stay snake_case because Retell constrains them to
 * [a-zA-Z0-9_-] and `TOOL_NAMES` already spells them that way for
 * `tool_invocations.tool_name`.
 */
export const TOOL_PATHS: Record<ToolName, string> = {
  check_availability: "/api/tools/check-availability",
  book_slot: "/api/tools/book-slot",
  confirm_appointment: "/api/tools/confirm-appointment",
  cancel_appointment: "/api/tools/cancel-appointment",
  // Inbound only (issue #43).
  book_appointment: "/api/tools/book-appointment",
  lookup_appointment: "/api/tools/lookup-appointment",
  log_enquiry: "/api/tools/log-enquiry",
};

/**
 * What each Tool accepts.
 *
 * Two rules hold across all four, and both are load-bearing:
 *
 * 1. **`slot_start` is an opaque token, not a datetime the model composes.**
 *    `check_availability` returns it; `book_slot` echoes it back verbatim. That
 *    keeps date arithmetic out of an LLM's hands, and it lets the endpoint verify
 *    server-side that a booked Slot was actually Offered during this Call — which
 *    is how "only ever offer times check_availability returned" becomes an
 *    enforced invariant instead of a prompt suggestion (SPEC.md §3 rule 6).
 *
 * 2. **No identifiers.** No appointment_id, business_id or call_id appears in any
 *    schema. The endpoint resolves identity from the `call` object Retell sends
 *    alongside `args`. If the Appointment id were an argument the model would be
 *    choosing which row it writes to, and one hallucinated uuid becomes a
 *    cross-tenant write.
 */
export const TOOL_PARAMETERS: Record<ToolName, ToolParameters> = {
  check_availability: {
    type: "object",
    properties: {
      preferred_time: {
        type: "string",
        description:
          "The time the customer said they would prefer, in their own words — " +
          "for example 'Thursday afternoon' or 'after 5pm tomorrow'. Omit this " +
          "if they have not named one.",
      },
      /*
        Inbound only, and optional so the outbound Agent's schema is unchanged
        in practice (issue #43).

        An outbound Call already knows the Service — it is on the Appointment
        Maya is ringing about, and the Slot is that long. An inbound caller has
        not said yet, and the Slot length depends on the answer, so this is how
        "I'd like a cleaning" becomes a 30-minute Slot rather than a 60-minute
        one. Omitted, the endpoint falls back to the Business's shortest
        Service, which is the choice that offers the most times.
      */
      service_name: {
        type: "string",
        description:
          "The service the caller asked for, matched against the list of " +
          "services you were given. Omit it if they have not said yet.",
      },
    },
    required: [],
  },
  book_slot: {
    type: "object",
    properties: {
      slot_start: {
        type: "string",
        description:
          "The slot_start value that check_availability returned for the time " +
          "the customer agreed to, copied exactly. Never reformat it and never " +
          "construct one yourself.",
      },
    },
    required: ["slot_start"],
  },
  // Both act on the Appointment this Call is already about, so they take nothing.
  // The empty schema is declared rather than omitted — cheaper than discovering
  // how Retell treats a missing `parameters` on a POST.
  confirm_appointment: { type: "object", properties: {}, required: [] },
  cancel_appointment: { type: "object", properties: {}, required: [] },

  /*
    Creates an Appointment for a caller who has none. The inbound twin of
    `book_slot`, and deliberately a separate Tool — see TOOL_DESCRIPTIONS.

    `caller_name` and `callback_number` are `required`, which is the schema-level
    half of SPEC.md §14 rule 11. The endpoint checks them again and refuses
    without them, because a required field in a JSON Schema is a request and the
    Tool is the enforcement (SPEC.md §3 rule 6). A Slot held for somebody
    unreachable is worse than an empty Slot: it blocks a real booking and nobody
    can undo it.
  */
  book_appointment: {
    type: "object",
    properties: {
      slot_start: {
        type: "string",
        description:
          "The slot_start value that check_availability returned for the time " +
          "the caller agreed to, copied exactly. Never reformat it and never " +
          "construct one yourself.",
      },
      caller_name: {
        type: "string",
        description:
          "The caller's full name, as they gave it. Ask for it before booking; " +
          "never guess it and never use a name from earlier in the call unless " +
          "they said it was theirs.",
      },
      callback_number: {
        type: "string",
        description:
          "A phone number to reach the caller on. Ask for it and read it back " +
          "to check. If they are calling from the number to use, say so and " +
          "confirm it with them rather than assuming.",
      },
      service_name: {
        type: "string",
        description:
          "The service they are booking, matched against the list you were " +
          "given.",
      },
    },
    required: ["slot_start", "caller_name", "callback_number", "service_name"],
  },

  /*
    Takes nothing, for the reason stated above the whole record: no identifiers
    in any schema. It matches on the number the caller is ringing from, which
    Retell supplies and the model never sees.

    Emphatically NOT a name lookup. "I'm calling about Sarah's appointment" from
    an unknown number would otherwise read a stranger's booking out loud.
  */
  lookup_appointment: { type: "object", properties: {}, required: [] },

  /*
    Writes down what the call was about when it did not end in a booking.

    `kind` is constrained in the description rather than by an enum because
    Retell's `properties` shape here is string-typed; the endpoint validates
    against ENQUIRY_KINDS and rejects anything else, so a hallucinated kind
    fails loudly instead of landing in the column.
  */
  log_enquiry: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        description:
          "One of exactly: question, complaint, callback, refused. Use " +
          "'callback' when they want a person to ring them, 'complaint' when " +
          "they are unhappy about something, 'refused' when you had to decline " +
          "to help, and 'question' otherwise.",
      },
      topic: {
        type: "string",
        description:
          "What they rang about, in one or two plain sentences, in your own " +
          "words. This is read by a person at the business, so write it for " +
          "them, not for a machine.",
      },
      caller_name: {
        type: "string",
        description: "Their name, if they gave one. Omit it if they did not.",
      },
      callback_number: {
        type: "string",
        description:
          "A number to ring them back on, if they gave one. Omit it if they " +
          "did not.",
      },
    },
    required: ["kind", "topic"],
  },
};

/**
 * What each Tool is for, in the words the model reads when deciding to call it.
 */
export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  check_availability:
    "Find open times for this customer. Call this whenever they say their " +
    "current time does not work, or ask what else is available. Returns up to " +
    "three open times in the business's local timezone. Only offer times this " +
    "returns.",
  book_slot:
    "Move this appointment to a time the customer has agreed to. Only call this " +
    "with a slot_start that check_availability returned during this call.",
  confirm_appointment:
    "Record that the customer confirmed their existing appointment time. Call " +
    "this as soon as they say the current time works.",
  cancel_appointment:
    "Cancel this appointment entirely. Call this only when the customer clearly " +
    "does not want the appointment at all, not when they want a different time.",

  /*
    Why this is not a wider `book_slot`.

    `book_slot` MOVES an existing Appointment, and 0003's partial unique index
    caps a Call at one committed Reschedule. `book_appointment` CREATES one.
    Overloading the pair would put a row-creating branch inside the path that
    guards Reschedules, and that index — which reads `tool_name = 'book_slot'` —
    would start meaning two different things at once.
  */
  book_appointment:
    "Book a new appointment for this caller. Only call this once you have a " +
    "slot_start that check_availability returned during this call, the " +
    "caller's name, and a number to reach them on. Never call it without all " +
    "three.",
  lookup_appointment:
    "Find any appointments already booked for the number this caller is " +
    "ringing from. Call this when they ask about an existing booking — when " +
    "theirs is, or whether they have one. Returns nothing if the number has no " +
    "appointments, which means you must not claim they have one.",
  log_enquiry:
    "Write down what this call was about, so somebody at the business sees it. " +
    "Call this before ending any call that did not end in a booking — a " +
    "question you answered, a complaint, a request for a callback, or " +
    "something you had to decline to help with.",
};

/**
 * Whether the Agent speaks a filler line while the Tool runs.
 *
 * On for the two that may take a beat — a silent second mid-conversation is dead
 * air, the most damaging failure mode available to a voice product (ADR-0003).
 * Off for the two that are single-row writes, where a filler line before "you're
 * all set" is just noise.
 */
const SPEAK_DURING_EXECUTION: Record<ToolName, string | null> = {
  check_availability: "Let me check what we have open.",
  /*
    Worded as a hold, not as an outcome. A live Call on 2026-08-21 ended with
    Maya saying "I'll book Monday at 12:30, I'm placing a hold now" and then the
    customer hanging up before `book_slot` was ever invoked — she announced a
    booking that did not exist. This line is the one thing she says between the
    customer agreeing and the write landing, so it has to promise effort rather
    than a result.
  */
  book_slot: "Please hold for a moment while I book that in.",
  confirm_appointment: null,
  cancel_appointment: null,
  // Same wording and the same reasoning as `book_slot`: a hold, never an
  // outcome. This is the one thing Maya says between the caller agreeing and
  // the write landing, so it promises effort rather than a result.
  book_appointment: "Please hold for a moment while I book that in.",
  // A read across two tables. Fast, but not instant, and the caller has just
  // asked a direct question — silence here reads as Maya not having heard.
  lookup_appointment: "Let me look that up for you.",
  // A single insert, and it happens as the call is winding up. A filler line
  // before "I've made a note of that" is just noise.
  log_enquiry: null,
};

/** The absolute URL a Tool is served at, for a given deployment. */
export function toolUrl(appUrl: string, name: ToolName): string {
  return new URL(TOOL_PATHS[name], appUrl).toString();
}

/**
 * The four Callzie Tools, ready to hand to Retell as `general_tools`.
 *
 * Both arguments are baked into the Agent at creation time, so changing either
 * means re-running `npm run create-agents` — see .env.example.
 */
export function customTools(
  appUrl: string,
  internalSecret: string,
  /*
    Which Tools this Agent gets. Defaults to the outbound four so every existing
    caller is unchanged.

    Handing an Agent the wrong set is not untidy, it is a broken Call: an
    inbound Agent given `book_slot` would invoke a Tool that looks for an
    Appointment the Call does not have, and an outbound Agent given
    `book_appointment` could create rows during a confirmation call. Passing the
    list explicitly is what stops `TOOL_NAMES` growing a fifth entry and
    silently arming every Agent with it.
  */
  names: readonly ToolName[] = OUTBOUND_TOOL_NAMES,
): CallzieCustomTool[] {
  return names.map((name) => {
    const filler = SPEAK_DURING_EXECUTION[name];

    return {
      type: "custom",
      name,
      description: TOOL_DESCRIPTIONS[name],
      url: toolUrl(appUrl, name),
      method: "POST",
      // The endpoints reject anything without this (issue #10).
      headers: { Authorization: `Bearer ${internalSecret}` },
      parameters: TOOL_PARAMETERS[name],
      speak_during_execution: filler !== null,
      // Always on: the model has to tell the customer what came back, and the
      // two sources disagree on the default, so it is never left implicit.
      speak_after_execution: true,
      // "static_text" speaks the string verbatim; "prompt" would treat it as an
      // instruction to improvise, which is a needless chance to say something wrong.
      ...(filler !== null
        ? {
            execution_message_type: "static_text" as const,
            execution_message_description: filler,
          }
        : {}),
      timeout_ms: TOOL_TIMEOUT_MS,
    };
  });
}

/**
 * Retell's built-in hang-up tool.
 *
 * Not a Callzie Tool — it writes nothing and is never recorded in
 * `tool_invocations`, which is why `TOOL_NAMES` stays four while `general_tools`
 * is five. It is not optional: SPEC.md §7's prompt says "end the call" in four of
 * its five branches, and without this the Agent physically cannot, so every Call
 * would run to the 180s cap and bill for it.
 */
export const END_CALL_TOOL = {
  type: "end_call" as const,
  name: "end_call",
  description:
    "End the call once the appointment is confirmed, rebooked or cancelled, or " +
    "once you have reached voicemail or a wrong number.",
};
