import { findAvailableSlots } from "@/lib/availability/find";
import { offeredSlotsInCall, type OfferedSlot } from "@/lib/tools/offers";
import type { ToolHandler } from "@/lib/tools/run";
import { NOT_COMMITTED } from "@/lib/tools/say";
import { spokenTime } from "@/lib/tools/spoken-time";

/**
 * `check_availability` — up to three open Slots, in Business-local time
 * (SPEC.md §7).
 *
 * A local Postgres query and nothing else (ADR-0003): this runs mid-conversation
 * and a third-party network call here would be dead air while the caller waits,
 * which is the most damaging failure mode available to a voice product.
 *
 * Nothing re-checks Business Hours or the past. `lib/availability/slots.ts`
 * already refuses to generate a Slot that runs past closing time or starts
 * before `now`, and a second check would be a second place to be wrong.
 *
 * Two rounds of this Tool in one Call return different times. The Slots this
 * Call has already named are subtracted, because SPEC.md §7's negotiation
 * requires "ask what would suit and call check_availability again" to mean
 * something — repeating the same three times is asking the same question louder.
 *
 * Note the asymmetry with `book_slot`, which is deliberate: this refuses to
 * *re-offer* a time, and `book_slot` still honours any time named at any point
 * in the Call. "Actually, the first one you said" is a real thing people say.
 *
 * `preferred_time` is deliberately unused. It is still recorded — `runTool`
 * writes every argument to `tool_invocations` — so the phrases people really use
 * can be read off the table before a parser is written for imagined ones. See
 * the design doc's known limitations.
 */

/** SPEC.md §7's table says "up to 3". Nobody holds five times in their head. */
export const MAX_OFFERS = 3;

/**
 * How far ahead to look.
 *
 * Long enough that a Business open two days a week still has something to offer;
 * short enough that the query stays small. Named rather than inlined because a
 * future `preferred_time` parser will want the same number.
 */
export const LOOKAHEAD_DAYS = 14;

const MS_PER_DAY = 86_400_000;

export type CheckAvailabilityResult = {
  ok: true;
  slots: OfferedSlot[];
  /** Only when there is nothing to offer. Otherwise she offers `slots` herself. */
  say?: string;
};

export const checkAvailability: ToolHandler = async ({ tx, context, now }) =>
  offerSlots({
    tx,
    now,
    callId: context.callId,
    businessId: context.businessId,
    serviceId: context.serviceId,
    timezone: context.timezone,
  });

/**
 * The body of `check_availability`, with the Service supplied rather than read
 * off a context.
 *
 * Extracted in issue #43 so the inbound Agent can run the identical query. The
 * only thing that differs between the two directions is *where the Service comes
 * from* — an outbound Call has one on its Appointment, an inbound caller has to
 * say — and everything after that point is the same query, the same de-duping,
 * and the same opaque `slot_start` token that `book_slot` and `book_appointment`
 * both have to echo back.
 *
 * Two copies of this would eventually disagree about what counts as offered,
 * and ADR-0011's proof-by-replay rests on there being exactly one answer to that.
 */
export async function offerSlots({
  tx,
  now,
  callId,
  businessId,
  serviceId,
  timezone,
}: {
  tx: Parameters<ToolHandler>[0]["tx"];
  now: Date;
  callId: string;
  businessId: string;
  serviceId: string;
  timezone: string;
}) {
  /*
    Every Slot this Call has already named. The same query `book_slot` runs to
    prove an Offer (ADR-0011), read here for the opposite purpose: not to check
    what we may honour, but to avoid saying it twice.
  */
  const alreadyOffered = await offeredSlotsInCall(tx, callId);

  const slots = await findAvailableSlots({
    businessId,
    serviceId,
    from: now,
    to: new Date(now.getTime() + LOOKAHEAD_DAYS * MS_PER_DAY),
    now,
    // Through the transaction, never the pool. `runTool` is already holding a
    // connection, and reaching for a second one deadlocks under concurrency —
    // see `Queryable` in lib/db/index.ts.
    database: tx,
  });

  /*
    Filtered before the slice, not after: taking three and then dropping the
    repeats would return one or two times when six were open.

    Compared on `toISOString()`, the same token `offeredSlotsInCall` stores and
    the same one `book_slot` normalises to, so there is exactly one spelling of
    an instant in this path.
  */
  const fresh = slots.filter(
    (slot) => !alreadyOffered.has(slot.startsAt.toISOString()),
  );

  const result: CheckAvailabilityResult = {
    ok: true,
    slots: fresh.slice(0, MAX_OFFERS).map((slot) => ({
      /*
        ISO 8601, and the token book_slot must echo back. ISO rather than an
        opaque hash because #16 has to render it and a support conversation has
        to be able to read it — lib/tools/offers.ts is what makes it unforgeable,
        not its shape.
      */
      slot_start: slot.startsAt.toISOString(),
      // What Maya says. A different format for a different job — see
      // lib/tools/spoken-time.ts.
      time: spokenTime(slot.startsAt, timezone),
    })),
  };

  /*
    Nothing left to offer — either the fortnight is full, or this Call has worked
    through everything in it. No `say` when there *are* Slots: Maya has to offer
    three times in her own words and react to the answer, and a script there
    would make her sound like an IVR.
  */
  if (result.slots.length === 0) result.say = NOT_COMMITTED.nothingOpen;

  /*
    `succeeded: true` even with an empty list. A fully booked fortnight is a fact
    about the Business, not a Tool failure — and recording it as one would make
    Maya say she will have someone call back (SPEC.md §8) about a question that
    was answered correctly.
  */
  return { succeeded: true, result };
};
