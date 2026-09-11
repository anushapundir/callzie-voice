import { randomBytes } from "node:crypto";

import { and, count, eq, gt } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type { BusinessType } from "@/lib/db/schema";

/*
  Who may open a widget Call, and how many (issue #45).

  **This is the only route in Callzie reachable without a session**, and it
  creates Retell Calls — which is to say it spends money on behalf of an account
  that is not present to approve it. Everything here is the fence around that.

  Four things have to be true, and none of them is sufficient alone:

  1. The key resolves to a Business.
  2. The request's `Origin` is one that Business listed.
  3. The Business has inbound answering switched on, with everything that
     implies — including an emergency number (SPEC.md §14 rule 10).
  4. Neither the daily widget cap nor the account's inbound allowance is spent.

  The key is not a secret and is not treated as one: it ships in HTML on a public
  page and anybody can read it. It identifies a tenant, nothing more. **The
  origin allowlist is what makes a stolen key useless**, and the caps are what
  hold when a thief is on the allowlist anyway — a compromised page on the
  business's own site, say.
*/

export const WIDGET_REJECT_REASONS = [
  "unknown_key",
  "origin_not_allowed",
  "inbound_disabled",
  "daily_cap_reached",
  "quota_exhausted",
] as const;
export type WidgetRejectReason = (typeof WIDGET_REJECT_REASONS)[number];

export type WidgetAuthorisation =
  | { ok: true; businessId: string; businessType: BusinessType }
  | { ok: false; reason: WidgetRejectReason };

/** How far back the daily cap counts. */
const DAY_MS = 86_400_000;

/**
 * A fresh widget key.
 *
 * 24 random bytes, base64url. Not a secret, but still unguessable — a
 * predictable key would let somebody enumerate accounts and read back each one's
 * Services and hours through the token route, which is a real if unexciting
 * leak. `randomBytes` rather than `Math.random`, because the cost of the correct
 * one here is nothing.
 *
 * Prefixed so it is recognisable in a support conversation and in somebody's
 * HTML, the way Stripe's publishable keys are.
 */
export function newWidgetKey(): string {
  return `czw_${randomBytes(24).toString("base64url")}`;
}

/**
 * Whether this origin is one the Business listed.
 *
 * An exact string match on the serialised origin — scheme, host and port — and
 * deliberately nothing cleverer. No wildcards, no subdomain matching, no
 * suffix comparison. `endsWith(".example.com")` is the classic way this check is
 * written and `evil-example.com` defeats it; a wildcard entry would let one
 * compromised subdomain spend an account's whole allowance.
 *
 * A missing `Origin` header fails. Browsers send it on cross-origin POSTs, which
 * is what the widget makes, so an absent one is not a browser doing the thing
 * this route exists for.
 */
export function originAllowed(
  origin: string | null,
  allowed: readonly string[],
): boolean {
  if (!origin) return false;

  /*
    Normalised through `URL` on both sides so "https://x.com" and
    "https://x.com/" and "https://X.com" are one value. Without this the check
    fails for a reason nobody can see, which is worse than failing loudly: an
    owner who typed a trailing slash gets a widget that silently never opens.
  */
  const asked = serialiseOrigin(origin);
  if (!asked) return false;

  return allowed.some((entry) => serialiseOrigin(entry) === asked);
}

function serialiseOrigin(value: string): string | null {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Whether this request may open a Call.
 *
 * The order is cheapest-first, the same discipline `decideInbound` follows, and
 * for the same reason: an unknown key is refused before anything counts rows.
 */
export async function authoriseWidget({
  key,
  origin,
  now = new Date(),
}: {
  key: string;
  origin: string | null;
  now?: Date;
}): Promise<WidgetAuthorisation> {
  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.widgetKey, key),
    columns: {
      id: true,
      businessType: true,
      inboundEnabled: true,
      inboundQuota: true,
      inboundCallsUsed: true,
      emergencyLine: true,
      isAdmin: true,
      widgetOrigins: true,
      widgetDailyCap: true,
    },
  });

  if (!business) return { ok: false, reason: "unknown_key" };

  if (!originAllowed(origin, business.widgetOrigins)) {
    return { ok: false, reason: "origin_not_allowed" };
  }

  /*
    The same two conditions `decideInbound` applies to a phone call, and they
    are not duplicated for symmetry — a widget Call reaches the same Agent, with
    the same Tools, and could receive the same emergency. Rule 10 does not stop
    applying because the caller arrived through a browser.
  */
  if (!business.inboundEnabled || !business.emergencyLine) {
    return { ok: false, reason: "inbound_disabled" };
  }

  if (
    !business.isAdmin &&
    business.inboundCallsUsed >= business.inboundQuota
  ) {
    return { ok: false, reason: "quota_exhausted" };
  }

  const today = await countWidgetCallsSince(
    business.id,
    new Date(now.getTime() - DAY_MS),
  );

  if (!business.isAdmin && today >= business.widgetDailyCap) {
    return { ok: false, reason: "daily_cap_reached" };
  }

  return { ok: true, businessId: business.id, businessType: business.businessType };
}

/**
 * Widget Calls started in the window.
 *
 * Inbound *and* web — the pair is what identifies a widget Call, since a phone
 * caller is inbound but not web, and an outbound Web Call is web but not
 * inbound. Counting either alone would let the phone eat the website's daily
 * cap or the other way round.
 */
async function countWidgetCallsSince(
  businessId: string,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.calls)
    .where(
      and(
        eq(schema.calls.businessId, businessId),
        eq(schema.calls.direction, "inbound"),
        eq(schema.calls.callType, "web"),
        gt(schema.calls.createdAt, since),
      ),
    );

  return row.n;
}
