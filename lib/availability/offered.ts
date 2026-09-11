import { loadSchedule } from "@/lib/availability/schedule";
import { db, type Queryable } from "@/lib/db";
import { openSlots } from "@/lib/availability/slots";

/**
 * Does this Business offer a Slot starting at exactly this instant?
 *
 * **This function never looks at other Appointments, and must not start.**
 * Whether a Slot is already taken is settled by the `appointments_no_overlap`
 * EXCLUDE constraint when the insert is attempted — see
 * `lib/availability/book.ts`. Asking the same question here would be a
 * check-then-write, which SPEC.md §3 rule 8 exists to rule out: three
 * concurrent Agents all read "free" before any of them writes.
 *
 * What is left is the half the database cannot answer. `appointments_no_overlap`
 * compares time ranges and knows nothing about `business_hours`, so opening
 * hours and past times have to be checked in application code. There is no
 * constraint here to undermine.
 *
 * `not_offered` covers two cases on purpose: the Business is closed then, and
 * the time is inside opening hours but off the Slot grid — 09:07 when Slots run
 * 09:00, 10:00, 11:00. Both mean the same thing to the person: that is not a
 * time you can book.
 */

export type SlotOffer = "offered" | "not_offered" | "in_the_past";

export type SlotIsOfferedInput = {
  businessId: string;
  serviceId: string;
  startsAt: Date;
  /** Injected rather than read, so callers and tests can pin it. */
  now?: Date;
  /**
   * Read through this instead of the pool.
   *
   * `book_slot` runs inside the transaction `lib/tools/run.ts` opens, and must
   * pass that transaction here — see `Queryable` in `lib/db/index.ts`.
   */
  database?: Queryable;
};

export async function slotIsOffered({
  businessId,
  serviceId,
  startsAt,
  now = new Date(),
  database = db,
}: SlotIsOfferedInput): Promise<SlotOffer> {
  /*
    Checked before generating anything. `openSlots` refuses to return a Slot
    before `now`, so a past time would come back as an empty list and be
    indistinguishable from "you are closed then" — two different sentences for
    the person to read.
  */
  if (startsAt.getTime() < now.getTime()) return "in_the_past";

  const { timezone, durationMinutes, hours } = await loadSchedule({
    businessId,
    serviceId,
    database,
  });

  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);

  const candidates = openSlots({
    hours,
    timezone,
    durationMinutes,
    // Never anything else. See this module's header.
    busy: [],
    /*
      A window exactly one Slot wide. `from` drops any Slot starting earlier and
      `to` drops any Slot ending later, so the only Slot that can survive is one
      that begins at exactly `startsAt` — which is also what makes an off-grid
      time fall out.
    */
    from: startsAt,
    to: endsAt,
    now,
  });

  return candidates.length === 1 ? "offered" : "not_offered";
}
