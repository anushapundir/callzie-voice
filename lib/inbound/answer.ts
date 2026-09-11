import { and, count, eq, gt } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { CALLER_RATE_WINDOW_MS, decideInbound } from "@/lib/inbound/decide";
import { buildInboundVariables } from "@/lib/inbound/variables";
import { agentIdFor } from "@/lib/retell/agents";

/*
  Everything the inbound webhook does between reading the request and writing the
  reply (issue #43).

  **This runs against a ten-second budget, on every inbound call.** Retell gives
  the webhook ten seconds and retries up to three times, and a call that has not
  been answered in that window is a customer listening to silence. So the shape
  here is fixed: a small number of indexed reads, no LLM, no third-party request,
  nothing that can hang. Two of the four reads happen only after the decision has
  already come out `admit`.

  Nothing here writes. In particular it does not create the `calls` row — there
  is no `retell_call_id` to write yet at `call_inbound` time. The Business id
  rides through in `metadata` and the existing `call_started` handler, which is
  already idempotent and already signature-verified, creates the row.
*/

export type InboundAnswer =
  | { admit: false; reason: string }
  | {
      admit: true;
      businessId: string;
      agentId: string;
      dynamicVariables: Record<string, string>;
    };

export async function answerInboundCall({
  toNumber,
  fromNumber,
  now = new Date(),
}: {
  toNumber: string;
  fromNumber: string | null;
  now?: Date;
}): Promise<InboundAnswer> {
  const business = await businessForNumber(toNumber);

  /*
    Counted only when there is a Business and a caller to count for. The rate
    limit is the one input that costs a round trip, and an unknown number is
    refused without it — which is what keeps a webhook probe cheap.
  */
  const recentCallsFromNumber =
    business && fromNumber
      ? await countRecentCallsFrom(fromNumber, now)
      : 0;

  const decision = decideInbound({
    business,
    fromNumber,
    recentCallsFromNumber,
  });

  if (!decision.admit) return { admit: false, reason: decision.reason };

  /*
    Resolved after the decision, not before. `agentIdFor` throws when the script
    has never been run against this database, and doing it here means that
    failure is caught by the route and turned into a rejection rather than an
    unhandled exception inside Retell's window.
  */
  const agentId = await agentIdFor(decision.businessType, "inbound");

  return {
    admit: true,
    businessId: decision.businessId,
    agentId,
    dynamicVariables: await buildInboundVariables(decision.businessId, now),
  };
}

/** Whose phone just rang. Null when no Business owns the number. */
async function businessForNumber(toNumber: string) {
  const [row] = await db
    .select({
      id: schema.businesses.id,
      businessType: schema.businesses.businessType,
      inboundEnabled: schema.businesses.inboundEnabled,
      inboundQuota: schema.businesses.inboundQuota,
      inboundCallsUsed: schema.businesses.inboundCallsUsed,
      emergencyLine: schema.businesses.emergencyLine,
      isAdmin: schema.businesses.isAdmin,
    })
    .from(schema.phoneNumbers)
    .innerJoin(
      schema.businesses,
      eq(schema.phoneNumbers.businessId, schema.businesses.id),
    )
    .where(eq(schema.phoneNumbers.e164, toNumber))
    .limit(1);

  return row ?? null;
}

/**
 * How many times this number has called in the last hour.
 *
 * Counts every inbound Call from the number across the whole platform, not just
 * this Business. An autodialler working through a list hits many Businesses
 * once each, and a per-Business count would never see it.
 */
async function countRecentCallsFrom(
  fromNumber: string,
  now: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.calls)
    .where(
      and(
        eq(schema.calls.fromNumber, fromNumber),
        eq(schema.calls.direction, "inbound"),
        gt(schema.calls.createdAt, new Date(now.getTime() - CALLER_RATE_WINDOW_MS)),
      ),
    );

  return row.n;
}
