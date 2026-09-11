import type { BusinessType } from "@/lib/db/schema";

/*
  Whether Maya answers this call (issue #43).

  Pure, and deliberately so. This runs inside Retell's ten-second inbound webhook
  budget on every single incoming call, and it is the only place that can refuse
  one before Callzie has spent anything at all — a rejected call costs nothing,
  an answered one costs a minute of voice whatever happens next.

  The guards are ordered cheapest-refusal-first, and the order is part of the
  design rather than a tidy-up: each one narrows what the next has to consider,
  and the first four need no counting query at all. `recentCallsFromNumber` is
  the only input that costs a round trip, so it is read last and only when
  everything else has already said yes.

  Nothing here reads the clock or the database. That is what makes every branch
  below testable as a value, which matters more here than almost anywhere else in
  the codebase: the failure mode of a wrong answer is either a stranger's call
  going unanswered, or an account being billed for calls it never agreed to take.
*/

/**
 * Why a call was refused.
 *
 * These are never spoken to the caller — Retell simply declines the call — but
 * they are recorded and shown to the account, because "your phone rang and we
 * did not answer" is something an owner is owed an explanation for. A silently
 * rejected customer is the worst outcome this feature can produce.
 */
export const INBOUND_REJECT_REASONS = [
  "unknown_number",
  "inbound_disabled",
  "no_emergency_line",
  "anonymous_caller",
  "quota_exhausted",
  "too_many_recent_calls",
] as const;
export type InboundRejectReason = (typeof INBOUND_REJECT_REASONS)[number];

/** The columns this decision needs. A subset, so tests need not build a row. */
export type InboundBusiness = {
  id: string;
  businessType: BusinessType;
  inboundEnabled: boolean;
  inboundQuota: number;
  inboundCallsUsed: number;
  emergencyLine: string | null;
  isAdmin: boolean;
};

export type InboundDecision =
  | { admit: true; businessId: string; businessType: BusinessType }
  | { admit: false; reason: InboundRejectReason };

/**
 * How many calls one number may place in the window before it is refused.
 *
 * Not a fraud model — a blunt stop on the obvious case, which is an autodialler
 * or a redial loop finding a number that always answers. Five is high enough
 * that a real person who rings back twice because the line dropped is never
 * caught by it, and low enough that nothing runs up a bill unattended.
 */
export const MAX_CALLS_PER_NUMBER = 5;

/** How far back `recentCallsFromNumber` should count. One hour. */
export const CALLER_RATE_WINDOW_MS = 60 * 60_000;

export type DecideInboundInput = {
  /** Null when no Business owns the number that was dialled. */
  business: InboundBusiness | null;
  /**
   * The caller's number, or null when the network withheld it.
   *
   * Retell sends `from_number` on every inbound call, but a withheld or blocked
   * caller ID arrives as an empty string on some carriers rather than as an
   * absent field, so the route normalises both to null before calling this.
   */
  fromNumber: string | null;
  /** Calls from this number inside `CALLER_RATE_WINDOW_MS`. */
  recentCallsFromNumber: number;
};

export function decideInbound({
  business,
  fromNumber,
  recentCallsFromNumber,
}: DecideInboundInput): InboundDecision {
  /*
    Nobody owns this number. Most likely a number released back to the carrier
    and re-issued, or somebody probing the webhook. Either way there is no
    account to bill and no Services to talk about.
  */
  if (!business) return { admit: false, reason: "unknown_number" };

  // The account has not asked to have its phone answered. Same shape and same
  // reasoning as SPEC.md §14 rule 6 for outbound.
  if (!business.inboundEnabled) {
    return { admit: false, reason: "inbound_disabled" };
  }

  /*
    No emergency number, so Maya cannot perform SPEC.md §14 rule 10 — the one
    refusal that matters most. An after-hours clinic line receives "I'm in a lot
    of pain, what should I do?", and the only acceptable answer is a real number
    and a hang-up.

    Settings refuses to turn `inboundEnabled` on without this, so reaching here
    means something wrote the flag another way. Declining the call is the right
    answer to that: not answering is recoverable, answering with nothing useful
    to say about an emergency is not.
  */
  if (!business.emergencyLine) {
    return { admit: false, reason: "no_emergency_line" };
  }

  /*
    A withheld caller ID cannot be rung back, cannot be rate limited, and cannot
    have `lookup_appointment` run against it. SPEC.md §14 rule 11 already refuses
    to book somebody unreachable, so the whole call would be Maya declining to do
    the useful thing — better to decline before the meter starts.
  */
  if (!fromNumber) return { admit: false, reason: "anonymous_caller" };

  /*
    Admins are exempt, matching the outbound Quota rule. Every other account
    stops at its allowance — and the account is told loudly, because from the
    caller's side this is indistinguishable from the business ignoring them.
  */
  if (!business.isAdmin && business.inboundCallsUsed >= business.inboundQuota) {
    return { admit: false, reason: "quota_exhausted" };
  }

  if (recentCallsFromNumber >= MAX_CALLS_PER_NUMBER) {
    return { admit: false, reason: "too_many_recent_calls" };
  }

  return {
    admit: true,
    businessId: business.id,
    businessType: business.businessType,
  };
}
