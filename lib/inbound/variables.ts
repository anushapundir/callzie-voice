import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { openNow } from "@/lib/inbound/open-now";
import { toWallTime } from "@/lib/settings/weekdays";

/**
 * What Maya is told about a Business before she says a word.
 *
 * Shared by both ways in: a phone call resolved through `lib/inbound/answer.ts`,
 * and a widget Call opened by `lib/widget/start.ts` (issues #43, #45). One
 * builder rather than two, because a visitor on the website and a caller on the
 * phone are talking to the same business and must hear the same answers — two
 * copies would be two places for `services_list` to drift, and the drift would
 * only ever be noticed by a customer.
 *
 * All values are strings. Retell renders anything else literally, so a plumbing
 * bug here is a sentence a caller hears — "curly-curly-business-name" — rather
 * than an error anybody sees (docs/verification.md A5).
 */
export async function buildInboundVariables(
  businessId: string,
  now: Date,
): Promise<Record<string, string>> {
  const [business, hours, services] = await Promise.all([
    db.query.businesses.findFirst({
      where: eq(schema.businesses.id, businessId),
      columns: { name: true, timezone: true, emergencyLine: true },
    }),
    db
      .select({
        weekday: schema.businessHours.weekday,
        opensAt: schema.businessHours.opensAt,
        closesAt: schema.businessHours.closesAt,
      })
      .from(schema.businessHours)
      .where(eq(schema.businessHours.businessId, businessId)),
    db
      .select({
        name: schema.services.name,
        durationMinutes: schema.services.durationMinutes,
      })
      .from(schema.services)
      .where(eq(schema.services.businessId, businessId)),
  ]);

  // Unreachable — every caller has already resolved this Business — but the
  // type is nullable and inventing a name for a caller would be worse than
  // throwing.
  if (!business) throw new Error(`No Business ${businessId}`);

  const open = openNow({
    hours: hours.map((h) => ({
      weekday: h.weekday,
      opensAt: toWallTime(h.opensAt),
      closesAt: toWallTime(h.closesAt),
    })),
    timezone: business.timezone,
    now,
  });

  return {
    business_name: business.name,
    /*
      The Services, rendered for speech. This is the whole of what Maya knows
      about what the business does — there is no knowledge base behind her, and
      that is deliberate: everything she can say about services is a row somebody
      typed into Settings, so she cannot invent one.
    */
    services_list: servicesList(services),
    is_open_now: open.isOpenNow ? "yes" : "no",
    hours_today: open.hoursToday,
    next_open: open.nextOpen ?? "unknown",
    local_time: open.localTime,
    emergency_line: business.emergencyLine ?? "",
  };
}

/** `"Cleaning (30 minutes), Whitening (60 minutes)"`. */
function servicesList(
  services: readonly { name: string; durationMinutes: number }[],
): string {
  if (services.length === 0) {
    /*
      A Business with no Services. Onboarding seeds some, so this means somebody
      deleted them all — and the honest thing is for Maya to have nothing to
      offer rather than a plausible-sounding list.
    */
    return "none listed";
  }

  return services
    .map((s) => `${s.name} (${s.durationMinutes} minutes)`)
    .join(", ");
}
