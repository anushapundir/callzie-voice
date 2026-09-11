import { and, eq } from "drizzle-orm";

import { checkDestination } from "@/lib/calls/destination";
import {
  buildDynamicVariables,
  validateDynamicVariables,
  type DynamicVariables,
} from "@/lib/calls/dynamic-variables";
import { releaseCallQuota } from "@/lib/calls/quota";
import { reserveCall } from "@/lib/calls/reserve";
import { db, schema } from "@/lib/db";
import { agentIdFor } from "@/lib/retell/agents";
import { retellClient } from "@/lib/retell/client";

/*
  Placing a Call (SPEC.md §7, docs/verification.md A3 and A6).

  The order of this function is the design. Everything that can refuse does so
  before anything is spent: the Appointment is resolved and scoped, the dynamic
  variables are validated, and only then is the Quota claimed and a Call row
  written — and only then is Retell contacted. That matches what the ticket asks
  for exactly: "a Call row is written before Retell is contacted, and the quota
  decrements".

  The microphone is NOT requested here. That happens in the browser before this
  function is ever called, which is what makes a declined prompt cost nothing at
  all. See components/calls/live-call-provider.tsx.

  This path places both kinds of Call, and which one is not a parameter. The
  scoped read below fetches `phone_calls_enabled` alongside the Appointment, and
  the route is that column — so there is no code path to `createPhoneCall` that
  did not go through the flag. SPEC.md §3 rule 9 and §14 rule 6, enforced
  structurally rather than by a check somebody has to remember. See ADR-0012.
*/

/**
 * The half of Retell this file uses, as a function.
 *
 * Injected rather than called directly so the whole orchestration — including
 * the compensating write when Retell fails — is exercised by tests that contact
 * nobody. SPEC.md §3 rule 11: no automated test places a real Call.
 */
export type WebCallCreator = (params: {
  agent_id: string;
  retell_llm_dynamic_variables: DynamicVariables;
  metadata: Record<string, string>;
}) => Promise<{ call_id: string; access_token: string }>;

/**
 * The real one. Not exported: it is the default for a parameter in this same
 * module, so exporting it would buy nothing and cost the guarantee below — an
 * `import { createWebCallWithRetell }` elsewhere would be a second way to reach
 * Retell, and the same is true of its phone twin.
 */
const createWebCallWithRetell: WebCallCreator = async (params) => {
  const response = await retellClient().call.createWebCall(params);
  return { call_id: response.call_id, access_token: response.access_token };
};

/**
 * The other half of Retell, as a function.
 *
 * Injected for the same reason `WebCallCreator` is: every branch, including the
 * compensating write, runs in tests that contact nobody (SPEC.md §3 rule 11).
 *
 * Note `override_agent_id` rather than `agent_id`. create-phone-call really does
 * name it differently from create-web-call (docs/verification.md A6), and
 * getting it wrong reaches a customer speaking the wrong Template's persona.
 */
export type PhoneCallCreator = (params: {
  from_number: string;
  to_number: string;
  override_agent_id: string;
  retell_llm_dynamic_variables: DynamicVariables;
  metadata: Record<string, string>;
  agent_override: typeof PHONE_AGENT_OVERRIDE;
}) => Promise<{ call_id: string }>;

/*
  How the shared Agents behave differently on a phone line. Retell applies
  these to one call and forgets them; the Agents themselves stay as
  scripts/create-agent.ts wrote them, which is what Web Calls keep using.

  Both settings came out of the first real US→India calls (docs/verification.md
  A2). They are per-call overrides rather than Agent settings because the trade
  is the phone line itself:

  - `start_speaker: "user"` — wait for hello. The carrier can signal "answered"
    seconds before a person is actually listening (screening services, early
    answer on international routes), and an agent that speaks first talks into
    that gap. A fixed `begin_message_delay_ms` only moves the gap; waiting for
    a voice closes it. On a Web Call the person just clicked "Start call", so
    there Maya greeting instantly is correct.

  - `begin_after_user_silence_ms` — but do not wait forever. The inactivity
    timer (`end_call_after_silence_ms`) only counts after agent speech, so a
    pickup where nobody speaks would otherwise sit mute for the whole
    180-second cap at phone rates. After ten seconds Maya introduces herself
    to the silence instead. That opening is LLM-generated, which triggers
    Retell's 10-second billing minimum — irrelevant here, because any call
    that got this far is already ten seconds old.

  - `language` / `stt_mode` — listen for Indian English, favour accuracy over
    latency. Phone Calls dial +91 numbers over a compressed international
    line; the `en-US` transcriber the Agents ship with misheard a real caller
    so badly that Retell recorded them as silent and hung up with
    `inactivity` after 54 seconds. Web audio is clean enough that the base
    setting can stand.
*/
export const PHONE_AGENT_OVERRIDE = {
  agent: {
    language: "en-IN",
    stt_mode: "accurate",
  },
  retell_llm: {
    start_speaker: "user",
    begin_after_user_silence_ms: 10_000,
  },
} as const;

/** The real one, and not exported either — see `createWebCallWithRetell`. */
const createPhoneCallWithRetell: PhoneCallCreator = async (params) => {
  const response = await retellClient().call.createPhoneCall(params);
  return { call_id: response.call_id };
};

export type StartCallResult =
  | { ok: true; callType: "web"; callId: string; accessToken: string }
  | { ok: true; callType: "phone"; callId: string; toNumber: string }
  | {
      ok: false;
      reason:
        | "not_found"
        | "needs_attention"
        | "exhausted"
        | "invalid_variables"
        | "retell_failed"
        | "phone_not_configured"
        | "phone_number_unusable";
      message: string;
    };

/** The `ok: true` half, named so callers can hold one without re-deriving it. */
export type StartCallSuccess = Extract<StartCallResult, { ok: true }>;

/*
  Worded for the person reading them on a dashboard, not for a log. Each one
  says what happened and, where it matters, what it cost — the Quota line in
  `retell_failed` is load-bearing, because a Call that visibly failed while the
  meter stayed put looks like a bug unless the screen says otherwise.
*/
const MESSAGES = {
  not_found: "That appointment no longer exists.",
  needs_attention:
    "This appointment needs attention. Clear it before calling again.",
  exhausted: "You've used all your calls.",
  invalid_variables:
    "This appointment is missing details Maya needs. Check the business name, " +
    "the customer's name and the service.",
  retell_failed: "Couldn't reach the calling service. Your call was not used.",
  phone_not_configured:
    "No phone number is configured for outbound calls. Set RETELL_FROM_NUMBER " +
    "on this deployment.",
  // `phone_number_unusable` has no entry: checkDestination writes its own
  // message, because "that is a demo number" and "that is not a phone number"
  // need different answers.
} as const;

export async function startCall({
  businessId,
  appointmentId,
  createWebCall = createWebCallWithRetell,
  createPhoneCall = createPhoneCallWithRetell,
}: {
  businessId: string;
  appointmentId: string;
  createWebCall?: WebCallCreator;
  createPhoneCall?: PhoneCallCreator;
}): Promise<StartCallResult> {
  /*
    Scoped to the Business inside the WHERE clause, not checked after the read.
    This is the cross-tenant guard: another account's Appointment simply does not
    resolve, so there is no branch that could act on one.
  */
  const [row] = await db
    .select({
      appointmentName: schema.appointments.name,
      startsAt: schema.appointments.startsAt,
      needsAttentionReason: schema.appointments.needsAttentionReason,
      serviceName: schema.services.name,
      businessName: schema.businesses.name,
      businessType: schema.businesses.businessType,
      timezone: schema.businesses.timezone,
      phoneCallsEnabled: schema.businesses.phoneCallsEnabled,
      phoneE164: schema.appointments.phoneE164,
    })
    .from(schema.appointments)
    .innerJoin(
      schema.services,
      eq(schema.appointments.serviceId, schema.services.id),
    )
    .innerJoin(
      schema.businesses,
      eq(schema.appointments.businessId, schema.businesses.id),
    )
    .where(
      and(
        eq(schema.appointments.id, appointmentId),
        eq(schema.appointments.businessId, businessId),
      ),
    )
    .limit(1);

  if (!row) {
    return { ok: false, reason: "not_found", message: MESSAGES.not_found };
  }

  /*
    SPEC.md §5: a non-null reason means Callzie will not call this person again
    until a human clears it. Phoning somebody to confirm a time that is about to
    change is worse than not phoning at all.

    **This is the only place the rule exists.** `startCall` is the one
    function that turns a request into a Call, so Call all (#17) and the Phone
    path (#19) inherit it without knowing it is here. Four call sites would be
    four places for it to drift, and the drift stays invisible until somebody
    gets phoned who should not have been.
  */
  if (row.needsAttentionReason !== null) {
    return {
      ok: false,
      reason: "needs_attention",
      message: MESSAGES.needs_attention,
    };
  }

  /*
    The route and the permission check are the same read — this is the guard
    SPEC.md §3 rule 9 asks for, and the reason it is not written as one.

    There is no `if (!enabled) refuse` anywhere, because there is nothing to
    refuse: an unflagged account does not reach a branch that could dial. It
    gets a Web Call. `createPhoneCall` below is reachable from exactly one
    branch, and the condition on that branch is the flag.

    Same argument as `claimCallQuota` and `appointments_no_overlap`: put the
    guarantee where it cannot be routed around, not where it has to be
    remembered. See ADR-0012.

    The flag is read once, here, so a Call already past this line completes even
    if an admin turns the flag off a moment later. Switching it off stops new
    Calls, not in-flight ones.
  */
  const route: "web" | "phone" = row.phoneCallsEnabled ? "phone" : "web";

  /*
    Validated before the Quota is touched. Retell renders an unset variable
    literally, so this is the difference between refusing a Call and Maya saying
    "curly-curly-name" to a customer (docs/verification.md A5).
  */
  const variables = buildDynamicVariables({
    businessName: row.businessName,
    name: row.appointmentName,
    serviceName: row.serviceName,
    startsAt: row.startsAt,
    timezone: row.timezone,
  });
  if (!validateDynamicVariables(variables).ok) {
    return {
      ok: false,
      reason: "invalid_variables",
      message: MESSAGES.invalid_variables,
    };
  }

  /*
    Both phone-only refusals sit above the Quota claim, so a Phone Call that
    cannot be placed has cost nothing. The tests assert that ordering rather
    than only the refusal — a guard below the claim would still return the right
    answer while quietly spending a Call.

    Both numbers are worked out once, here, and carried down to the dial below.
    That is the point rather than a tidiness: the number that was checked has to
    be the number that gets dialled.

    For `fromNumber`, reading the environment a second time later would let a
    blank value slip past the refusal it just passed. For `toNumber`,
    `checkDestination` tests the normalised form — `+1 (202) 555-0110` becomes
    `+12025550110` before its fictional-range check runs — so dialling
    `row.phoneE164` instead would dial a string nothing ever checked.
  */
  let fromNumber = "";
  let toNumber = "";
  if (route === "phone") {
    fromNumber = process.env.RETELL_FROM_NUMBER?.trim() ?? "";
    if (!fromNumber) {
      return {
        ok: false,
        reason: "phone_not_configured",
        message: MESSAGES.phone_not_configured,
      };
    }

    const destination = checkDestination(row.phoneE164);
    if (!destination.ok) {
      return {
        ok: false,
        reason: "phone_number_unusable",
        message: destination.message,
      };
    }
    toNumber = destination.number;
  }

  // Throws if the Agents have never been provisioned against this database,
  // which is a deployment gap rather than something the caller did wrong.
  const agentId = await agentIdFor(row.businessType);

  /*
    The claim and the Call row land together or not at all. A claimed Call with
    no row charges someone for nothing; a row with no claim gives a Call away.

    The three writes live in lib/calls/reserve.ts, shared with issue #17's batch
    pump — including the count, which has to be inside this transaction so two
    concurrent Calls for the same Appointment cannot both come out as attempt 2.
  */
  let callId: string;
  try {
    callId = await db.transaction(async (tx) => {
      const reserved = await reserveCall(tx, {
        businessId,
        appointmentId,
        callType: route,
      });
      if (!reserved.ok) throw new QuotaExhausted();

      return reserved.callId;
    });
  } catch (error) {
    if (error instanceof QuotaExhausted) {
      return { ok: false, reason: "exhausted", message: MESSAGES.exhausted };
    }
    throw error;
  }

  /*
    Outside the transaction, because it is a network call — holding a row lock
    across an HTTP round trip would block every other Call the account places.

    So a failure here cannot roll back. It is compensated instead: the row is
    marked failed and the Quota is handed back. This is the only refund in the
    system, and it is the only failure we can prove on the server. A browser
    saying "the call never connected" is a claim nobody can check.
  */
  try {
    // Echoed back on every webhook, so #13 can recover the Call even if an
    // event arrives before this row is visible to it. Identical on both routes,
    // so #13 needs no branch of its own.
    const metadata = { call_id: callId, appointment_id: appointmentId };

    // The one genuine branch. Different endpoint, different parameter names,
    // different return. Everything above and below is shared.
    let retellCallId: string;
    let success: StartCallSuccess;

    if (route === "phone") {
      const response = await createPhoneCall({
        from_number: fromNumber,
        to_number: toNumber,
        override_agent_id: agentId,
        retell_llm_dynamic_variables: variables,
        metadata,
        agent_override: PHONE_AGENT_OVERRIDE,
      });
      retellCallId = response.call_id;
      success = { ok: true, callType: "phone", callId, toNumber };
    } else {
      const response = await createWebCall({
        agent_id: agentId,
        retell_llm_dynamic_variables: variables,
        metadata,
      });
      retellCallId = response.call_id;
      success = {
        ok: true,
        callType: "web",
        callId,
        accessToken: response.access_token,
      };
    }

    await db
      .update(schema.calls)
      .set({ retellCallId })
      .where(eq(schema.calls.id, callId));

    await db
      .update(schema.appointments)
      .set({ status: "calling" })
      .where(eq(schema.appointments.id, appointmentId));

    return success;
  } catch {
    await db
      .update(schema.calls)
      .set({
        status: "failed",
        disconnectReason: `create_${route}_call_failed`,
      })
      .where(eq(schema.calls.id, callId));
    await releaseCallQuota(db, businessId);

    return {
      ok: false,
      reason: "retell_failed",
      message: MESSAGES.retell_failed,
    };
  }
}

/**
 * Rolls the transaction back without making an exhausted Quota look like a
 * crash. Drizzle only aborts a transaction on a throw, and an exhausted Quota is
 * an ordinary answer rather than an error — so it is thrown here and turned back
 * into a value immediately above.
 */
class QuotaExhausted extends Error {}
