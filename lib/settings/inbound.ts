import { and, eq, isNotNull, ne, sql } from "drizzle-orm";

import { parseE164 } from "@/lib/appointments/phone";
import { db, schema } from "@/lib/db";

/*
  Turning inbound on, and the emergency number it depends on (issue #43).

  Same discipline as `lib/settings/phone-calls.ts`: the guard lives in the WHERE
  clause, not in a branch above the write. A Server Action is a POST anybody can
  send, and rendering a switch on a gated screen is not a security boundary.

  Unlike `phone_calls_enabled`, this is not admin-only. Answering the phone is a
  thing an ordinary account should be able to turn on for itself — the cost is
  bounded by `inbound_quota` and the risk is bounded by the emergency number
  below, neither of which is true of arbitrary outbound dialling.
*/

export type InboundEnableResult =
  | { ok: true }
  | { ok: false; reason: "no_emergency_line" | "not_found" };

/**
 * Turns inbound answering on or off.
 *
 * **Refuses to turn it on without an emergency number**, and that is the whole
 * reason this is not a one-line update. Maya cannot perform SPEC.md §14 rule 10
 * without one, and rule 10 is the highest-risk path in the feature: an
 * always-on clinic line receives "I'm in a lot of pain, what should I do?" in
 * its first week, and the only acceptable answer is a real number and a hang-up.
 *
 * `decideInbound` checks this again at call time and declines the call if it is
 * missing. Two locks on one door, because this one is a form somebody fills in
 * and that one is the last thing standing before a stranger is connected.
 *
 * Turning it *off* is never refused. A business that wants its phone to stop
 * being answered must always be able to say so immediately.
 */
export async function setInboundEnabled(
  businessId: string,
  enabled: boolean,
): Promise<InboundEnableResult> {
  const rows = await db
    .update(schema.businesses)
    .set({ inboundEnabled: enabled })
    .where(
      and(
        eq(schema.businesses.id, businessId),
        /*
          The condition is in the statement rather than read-then-write, so two
          requests racing — one clearing the emergency number, one enabling
          inbound — cannot both succeed and leave the flag on with no number
          behind it.

          `ne(emergencyLine, '')` as well as `isNotNull`, because an empty
          string is what an emptied form field submits and it is just as useless
          to read out loud as a null.
        */
        enabled
          ? and(
              isNotNull(schema.businesses.emergencyLine),
              ne(schema.businesses.emergencyLine, ""),
            )
          : sql`true`,
      ),
    )
    .returning({ id: schema.businesses.id });

  if (rows.length > 0) return { ok: true };

  /*
    Nothing changed. Distinguish the two causes, because they need different
    things from the person: one is "add a number first", the other is "this is
    not your Business" and should not be explained at all.
  */
  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.id, businessId),
    columns: { emergencyLine: true },
  });

  if (!business) return { ok: false, reason: "not_found" };
  return { ok: false, reason: "no_emergency_line" };
}

export type EmergencyLineResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

/**
 * Sets the number Maya reads out to somebody describing an emergency.
 *
 * Stored in E.164 like every other number Callzie holds (SPEC.md §3 rule 10).
 * A number that does not parse is refused rather than stored, because the one
 * moment it gets used is the moment it has to work.
 *
 * Clearing it also switches inbound off, in the same statement. Leaving the flag
 * on with no number would put the Business in exactly the state `decideInbound`
 * declines every call for — the phone would appear to be answered and would
 * silently stop being.
 */
export async function setEmergencyLine(
  businessId: string,
  raw: string,
): Promise<EmergencyLineResult> {
  const trimmed = raw.trim();

  if (trimmed === "") {
    await db
      .update(schema.businesses)
      .set({ emergencyLine: null, inboundEnabled: false })
      .where(eq(schema.businesses.id, businessId));

    return { ok: true, value: null };
  }

  const parsed = parseE164(trimmed);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  await db
    .update(schema.businesses)
    .set({ emergencyLine: parsed.value })
    .where(eq(schema.businesses.id, businessId));

  return { ok: true, value: parsed.value };
}
