import { asc, eq } from "drizzle-orm";

import { schema } from "@/lib/db";
import type { Tx } from "@/lib/tools/run";

/*
  Which Service an inbound caller means (issue #43).

  An outbound Call already knows: the Service is on the Appointment Maya is
  ringing about, and the Slot is that long. An inbound caller says "I'd like a
  cleaning", and the Slot length depends on which row that is.

  The matching is deliberately dull — exact, then case-insensitive, then
  substring, then give up. It is not trying to be clever, because the failure
  mode of clever here is booking somebody a 90-minute appointment when they
  asked for a 20-minute one, and nobody finds out until they arrive.

  Note that the model is *given* the list of Services in its prompt
  (`services_list`) and told to match against it, so by the time this runs the
  string is usually a Service name copied verbatim. The fallbacks exist for the
  ordinary human mess around that — "a cleaning" for "Cleaning", different case,
  a trailing full stop.
*/

export type ServiceChoice = {
  id: string;
  name: string;
  durationMinutes: number;
};

/**
 * The Service this caller asked for, or the shortest one.
 *
 * **Falls back to the shortest, never to the first.** With no name to go on, the
 * shortest Service is the one that offers the most Slots and books the least of
 * somebody's day. Being wrong towards "too little time" is recoverable at the
 * desk; being wrong towards "we have blocked out ninety minutes" is a hole in
 * the diary nobody asked for.
 *
 * Returns null only when the Business has no Services at all, which onboarding
 * makes hard and deleting them all makes possible.
 */
export async function chooseService(
  tx: Tx,
  businessId: string,
  requested: unknown,
): Promise<ServiceChoice | null> {
  const services = await tx
    .select({
      id: schema.services.id,
      name: schema.services.name,
      durationMinutes: schema.services.durationMinutes,
    })
    .from(schema.services)
    .where(eq(schema.services.businessId, businessId))
    // Shortest first, so the fallback below is just "take the head".
    .orderBy(asc(schema.services.durationMinutes));

  if (services.length === 0) return null;

  if (typeof requested !== "string" || requested.trim() === "") {
    return services[0];
  }

  const wanted = normalise(requested);

  const exact = services.find((s) => normalise(s.name) === wanted);
  if (exact) return exact;

  /*
    Substring in both directions: "cleaning" should find "Deep Cleaning", and
    "a deep cleaning please" should find "Deep Cleaning".

    Longest name first, so "Deep Cleaning" wins over "Cleaning" when the caller
    said "deep cleaning" — the more specific match is the one they meant, and
    without the sort it would depend on which row happened to be shorter.
  */
  const byLength = [...services].sort((a, b) => b.name.length - a.name.length);

  const contained = byLength.find(
    (s) => wanted.includes(normalise(s.name)) || normalise(s.name).includes(wanted),
  );
  if (contained) return contained;

  return services[0];
}

/** Lowercased, punctuation dropped, whitespace collapsed. */
function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
