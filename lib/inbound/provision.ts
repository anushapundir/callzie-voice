import { attachNumber, detachNumber } from "@/lib/inbound/numbers";

/*
  Buying and releasing a number at Retell (issue #44).

  Every function here takes its Retell operations as arguments rather than
  reaching for `retellClient()`. That is the same discipline
  `lib/calls/start-call.ts` applies to placing a Call, and for the same reason:
  SPEC.md §3 rule 11 says no automated test may contact Retell, and injection is
  what makes the *orchestration* — including the compensating write when the
  second step fails — testable without contacting anybody.

  **This is the one part of Callzie that spends money on a schedule.** A number
  is about $2 a month whether or not it ever rings, and unlike a Call there is
  nothing that stops. The consequence shapes both functions below: purchase
  records the row in the same breath as the purchase, and release deletes the row
  before telling Retell, so the failure that survives is the visible one.
*/

/** Buying a number, as a function. Injected so tests contact nobody. */
export type NumberPurchaser = (params: {
  area_code?: number;
  inbound_webhook_url: string;
}) => Promise<{ phone_number: string; phone_number_id?: string }>;

/** Releasing one. Same reasoning. */
export type NumberReleaser = (numberId: string) => Promise<void>;

export type ProvisionResult =
  | { ok: true; e164: string }
  | {
      ok: false;
      reason: "not_enabled" | "already_taken" | "invalid_number" | "purchase_failed";
      /** Set when Retell bought a number that Callzie then could not record. */
      orphanedNumber?: string;
    };

/**
 * Buys a number and points it at this Business.
 *
 * The order is forced and it is the lesser of two evils. Retell has to purchase
 * before there is a number to record, so there is an instant where a number
 * exists with no row — and if the row write then fails, that number is orphaned
 * and billing.
 *
 * So the failure is **reported rather than swallowed**: `orphanedNumber` carries
 * the number that was bought, and the caller is expected to put it in front of a
 * human. Releasing it automatically was the obvious alternative and is worse — a
 * release that itself fails would leave nothing anywhere pointing at a number
 * that costs money every month, which is precisely the state that goes unnoticed
 * for a year.
 *
 * The inbound webhook URL is baked in at purchase time, exactly as
 * `scripts/create-agent.ts` bakes `APP_URL` into the Agents. The same warning
 * applies: it must be the deployed origin, because Retell calls it from its own
 * servers and can never reach a localhost.
 */
export async function provisionNumber({
  businessId,
  appUrl,
  areaCode,
  purchase,
}: {
  businessId: string;
  appUrl: string;
  areaCode?: number;
  purchase: NumberPurchaser;
}): Promise<ProvisionResult> {
  const inboundWebhookUrl = new URL(
    "/api/webhooks/retell/inbound",
    appUrl,
  ).toString();

  let bought: { phone_number: string; phone_number_id?: string };
  try {
    bought = await purchase({
      ...(areaCode === undefined ? {} : { area_code: areaCode }),
      inbound_webhook_url: inboundWebhookUrl,
    });
  } catch {
    // Nothing was bought, so nothing is orphaned. The cheapest failure here.
    return { ok: false, reason: "purchase_failed" };
  }

  const attached = await attachNumber({
    businessId,
    e164: bought.phone_number,
    retellNumberId: bought.phone_number_id,
    purpose: "inbound",
  });

  if (!attached.ok) {
    return {
      ok: false,
      reason: attached.reason,
      // A real number, really bought, with no row pointing at it. Say so.
      orphanedNumber: bought.phone_number,
    };
  }

  return { ok: true, e164: bought.phone_number };
}

export type ReleaseResult =
  | { ok: true; releasedAtRetell: boolean }
  | { ok: false; reason: "not_found" | "release_failed"; e164?: string };

/**
 * Stops routing a number here, and gives it back.
 *
 * The row goes first. A failure to release then leaves a number nobody routes to
 * — visible in the Retell dashboard, costing $2 a month, and findable. The other
 * ordering would leave a Business routing to a number that no longer exists,
 * which is invisible: the phone simply stops being answered and nothing on any
 * screen says why.
 *
 * `releasedAtRetell: false` means the row is gone and Retell still holds the
 * number. That is a state a human has to finish, and it is returned rather than
 * retried because a retry loop against a billing operation is not something to
 * run unattended.
 */
export async function releaseNumber({
  businessId,
  numberId,
  release,
}: {
  businessId: string;
  numberId: string;
  release: NumberReleaser;
}): Promise<ReleaseResult> {
  const detached = await detachNumber(businessId, numberId);
  if (!detached) return { ok: false, reason: "not_found" };

  // Never provisioned against Retell — a row somebody attached by hand. Nothing
  // to give back.
  if (!detached.retellNumberId) return { ok: true, releasedAtRetell: false };

  try {
    await release(detached.retellNumberId);
    return { ok: true, releasedAtRetell: true };
  } catch {
    return { ok: true, releasedAtRetell: false };
  }
}
