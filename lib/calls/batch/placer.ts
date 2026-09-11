import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/*
  The one thing issue #17 does not build: dialling.

  Call All needs three Calls at once, and only the Phone Call path has any
  concurrency — a Web Call needs a browser to join it within 30 seconds
  (`docs/verification.md` A3), and a browser has one microphone. So the engine
  is built against this port and issue #19 supplies the implementation, along
  with the KYC, the number purchase and the kill switch.

  Everything the batch does is proven against a fake placer, which is also what
  keeps SPEC.md §3 rule 11 — no automated test places a real Call.
*/

export type PlaceCallParams = {
  businessId: string;
  appointmentId: string;
  /** The `calls` row the pump already reserved, waiting for a Retell id. */
  callId: string;
};

export type PlaceCallResult = { ok: true } | { ok: false; reason: string };

export type CallPlacer = (params: PlaceCallParams) => Promise<PlaceCallResult>;

/**
 * Today's only implementation.
 *
 * The flag check is deliberately duplicated — `pumpBatch` refuses before it
 * claims anything, so nothing reaches here on an unflagged account. It is
 * repeated because SPEC.md §3 rule 9 and issue #19 say an unflagged account
 * cannot place a Phone Call *by any route*, and a guard at the boundary is
 * worth more than a guard on the caller.
 *
 * `reason` lands in `calls.disconnect_reason`, so it is a short machine string
 * rather than a sentence — the same convention `create_web_call_failed` follows
 * in lib/calls/start-web-call.ts.
 */
export const refusingPlacer: CallPlacer = async ({ businessId }) => {
  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.id, businessId),
    columns: { phoneCallsEnabled: true },
  });

  if (!business?.phoneCallsEnabled) {
    return { ok: false, reason: "phone_calls_disabled" };
  }

  return { ok: false, reason: "phone_calls_not_implemented" };
};
