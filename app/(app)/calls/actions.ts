"use server";

import { revalidatePath } from "next/cache";

import { requireBusiness } from "@/lib/business/require-business";
import {
  recordCallEnded,
  recordCallFailed,
  recordCallStarted,
} from "@/lib/calls/record";
import { startCall } from "@/lib/calls/start-call";

/*
  The Server Actions for placing and reporting a Call.

  Three rules, the same ones app/(app)/settings/actions.ts documents.
  `requireBusiness()` comes first in every one, because a Server Action is a POST
  anyone can send and rendering a button on an authenticated screen is not a
  security boundary. Nothing closes over anything. A refusal comes back as a
  value rather than a throw, because SPEC.md §11.4 wants inline persistent UI for
  anything requiring action.

  Every one of these is a thin wrapper on purpose: authenticate, delegate,
  revalidate. The writes live in lib/calls/ where they are tested without Clerk,
  including the cross-tenant guard — `callId` arrives from the browser, so each
  of the three reporters is reachable with somebody else's id.

  On trusting the browser at all. Until #13's webhook receiver exists, the page
  is the only thing that knows a Call started or ended. A forged POST here can
  only move a Call the account already owns and has already paid for — the worst
  available outcome is an account lying to its own dashboard. No Quota is
  returned by any of the three reporters, so there is nothing to farm. #13's
  webhook is the authoritative writer and overwrites all of it.

  A Phone Call reports none of this. There is no browser on the line, so the
  three reporters below are never called for one, and two rows are left where
  `startCall` put them. The Call row stays `queued` — there is no `calling` in
  `CALL_STATUSES`, and nothing moves it off `queued` on this route. The
  Appointment row is the one that reads `calling`. Both wait for #13's webhook.
  That is the correct answer rather than a gap: the only honest source for a
  Phone Call's outcome is Retell.
*/

/**
 * What comes back to the browser.
 *
 * The two success arms are copied out by hand rather than reused from
 * `StartCallSuccess` in lib/calls/start-call.ts, and that is the point: this is
 * an allowlist of what may cross to the browser. A Server Action's return value
 * is serialised and shipped as-is, so `return result` would silently hand over
 * any field a later edit adds to `StartCallResult`. Adding one here has to be a
 * decision somebody made.
 */
export type StartCallState =
  | { ok: true; callType: "web"; callId: string; accessToken: string }
  | { ok: true; callType: "phone"; callId: string; toNumber: string }
  | { ok: false; message: string };

/**
 * Places a Call for one Appointment — which kind is not this function's
 * decision, and deliberately not the caller's either.
 *
 * There is one argument, and it is an Appointment id. A Server Action is a POST
 * anybody can send, so a `route` parameter here would be exactly the thing
 * SPEC.md §3 rule 9 forbids: a way to ask for a Phone Call. `startCall` reads
 * `phone_calls_enabled` for the sender's own Business and decides. A crafted
 * request reaches this same function and gets a Web Call.
 */
export async function startCallAction(
  appointmentId: string,
): Promise<StartCallState> {
  const { business } = await requireBusiness();

  const result = await startCall({ businessId: business.id, appointmentId });

  // The Quota meter and the row's status have both moved.
  revalidatePath("/");

  if (!result.ok) return { ok: false, message: result.message };
  return result.callType === "web"
    ? {
        ok: true,
        callType: "web",
        callId: result.callId,
        accessToken: result.accessToken,
      }
    : {
        ok: true,
        callType: "phone",
        callId: result.callId,
        toNumber: result.toNumber,
      };
}

export async function reportCallStartedAction(callId: string): Promise<void> {
  const { business } = await requireBusiness();

  await recordCallStarted(business.id, callId);

  revalidatePath("/");
}

export async function reportCallEndedAction(callId: string): Promise<void> {
  const { business } = await requireBusiness();

  await recordCallEnded(business.id, callId);

  revalidatePath("/");
}

export async function reportCallFailedAction(
  callId: string,
  disconnectReason: string,
): Promise<void> {
  const { business } = await requireBusiness();

  await recordCallFailed(business.id, callId, disconnectReason);

  revalidatePath("/");
}
