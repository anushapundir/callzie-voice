import { slotIsOffered } from "@/lib/availability/offered";
import { parseE164 } from "@/lib/appointments/phone";
import { schema } from "@/lib/db";
import { isSlotTaken } from "@/lib/availability/slot-taken";
import type { InboundToolContext } from "@/lib/tools/request";
import { offeredSlotsInCall } from "@/lib/tools/offers";
import type { ToolHandler, ToolOutcome } from "@/lib/tools/run";
import { COMMITTED, NOT_COMMITTED } from "@/lib/tools/say";
import { chooseService } from "@/lib/tools/service-choice";
import { spokenTime } from "@/lib/tools/spoken-time";

/**
 * `book_appointment` — a caller who rang in walks away with a real Slot
 * (issue #43).
 *
 * The inbound twin of `book_slot`, and deliberately a separate Tool rather than
 * a wider one. `book_slot` MOVES an Appointment and is capped by
 * `tool_invocations_one_booking_per_call`; this CREATES one and is capped by
 * `tool_invocations_one_new_booking_per_call`. Merging them would put a
 * row-creating branch inside the path that guards Reschedules, and that index —
 * which reads `tool_name = 'book_slot'` — would start meaning two things.
 *
 * The checks, in order, each cheaper than the next:
 *
 * 1. A name and a reachable number (SPEC.md §14 rule 11).
 * 2. Is `slot_start` a time at all?
 * 3. Did we offer it in **this** Call? (`lib/tools/offers.ts`, ADR-0011)
 * 4. Is it inside Business Hours and still ahead? (`lib/availability/offered.ts`)
 * 5. Insert, and let `appointments_no_overlap` settle the race.
 *
 * **Rule 11 is check 1 for a reason.** A Slot held for somebody unreachable is
 * worse than an empty Slot: it blocks a real booking, and nobody can undo it
 * because nobody knows who to ring. The schema marks both fields `required`,
 * which is a request to the model; this is the enforcement (SPEC.md §3 rule 6).
 *
 * **And as with `book_slot`: this never returns `ok: true` for a write that did
 * not happen.** SPEC.md §3 rule 7.
 */

/** SPEC.md §8: "Retry once, silently." So two attempts, not two retries. */
const ATTEMPTS = 2;

export type BookAppointmentRefusal =
  | "missing_name"
  | "missing_number"
  | "invalid_number"
  | "invalid_time"
  | "not_offered"
  | "in_the_past"
  | "no_service"
  | "slot_taken";

/**
 * A refusal, with the words that go with it.
 *
 * The three that mean "I still need something from you" get a line that asks for
 * it, because the call is recoverable and Maya should just ask again. Only
 * `slot_taken` promises a callback — it is the one case where the caller did
 * everything right and Callzie could not deliver.
 */
function refuse(reason: BookAppointmentRefusal): ToolOutcome {
  const say = (() => {
    switch (reason) {
      case "missing_name":
        return "Before I can book that, could I take your full name?";
      case "missing_number":
      case "invalid_number":
        return "Could I take a phone number to reach you on?";
      case "slot_taken":
        return NOT_COMMITTED.bookFailed;
      case "no_service":
        return NOT_COMMITTED.nothingOpen;
      default:
        return NOT_COMMITTED.notAvailable;
    }
  })();

  return { succeeded: false, result: { ok: false, reason, say } };
}

export const bookAppointmentTool: ToolHandler<InboundToolContext> = async ({
  tx,
  context,
  args,
  now,
}) => {
  const callerName = typeof args.caller_name === "string" ? args.caller_name.trim() : "";
  if (callerName === "") return refuse("missing_name");

  /*
    The number is validated, not merely present. SPEC.md §3 rule 10 keeps every
    stored number in E.164, and a booking whose number does not parse is exactly
    the unreachable booking rule 11 exists to prevent — it would look fine in the
    table and fail the moment anybody tried to ring it.
  */
  const supplied = args.callback_number;
  if (typeof supplied !== "string" || supplied.trim() === "") {
    return refuse("missing_number");
  }

  const parsed = parseE164(supplied);
  if (!parsed.ok) return refuse("invalid_number");

  const slotStart = args.slot_start;
  if (typeof slotStart !== "string") return refuse("invalid_time");

  const startsAt = new Date(slotStart);
  if (Number.isNaN(startsAt.getTime())) return refuse("invalid_time");

  /*
    Compared on the normalised instant, not the raw string — the same reasoning
    as `book_slot`. "…+00:00" and "…Z" are the same moment, and refusing a
    booking somebody just agreed to over a formatting difference is the wrong
    way to be strict.
  */
  const token = startsAt.toISOString();
  const offered = await offeredSlotsInCall(tx, context.callId);
  if (!offered.has(token)) return refuse("not_offered");

  const service = await chooseService(tx, context.businessId, args.service_name);
  if (!service) return refuse("no_service");

  /*
    SPEC.md §3 rule 6 and §14 rule 1, enforced here and never in the prompt. The
    Slot was offered against whatever Service `check_availability` used, so this
    re-checks against the one actually being booked — a caller who said
    "cleaning" while browsing and "whitening" while booking must not get a
    60-minute appointment in a 30-minute hole.
  */
  const stillOpen = await slotIsOffered({
    businessId: context.businessId,
    serviceId: service.id,
    startsAt,
    now,
    // Through the transaction, never the pool — see lib/tools/check-availability.ts.
    database: tx,
  });
  if (stillOpen === "in_the_past") return refuse("in_the_past");
  if (stillOpen !== "offered") return refuse("not_offered");

  const endsAt = new Date(startsAt.getTime() + service.durationMinutes * 60_000);

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    /*
      Each attempt on its own savepoint, so a lost race does not poison the
      transaction and end the Call — the same mechanism `rescheduleAppointment`
      uses for `book_slot`.
    */
    try {
      const [created] = await tx.transaction(async (savepoint) =>
        savepoint
          .insert(schema.appointments)
          .values({
            businessId: context.businessId,
            serviceId: service.id,
            name: callerName,
            phoneE164: parsed.value,
            startsAt,
            endsAt,
            /*
              `confirmed`, not `pending`. The person asked for this time and
              agreed to it out loud thirty seconds ago — there is nothing left to
              confirm, and leaving it pending would put them in the queue to be
              rung about a booking they just made.
            */
            status: "confirmed",
          })
          .returning({ id: schema.appointments.id }),
      );

      const spoken = spokenTime(startsAt, context.timezone);

      /*
        Written here rather than by `log_enquiry`, so a Call that books is
        recorded as having booked even if the model never gets to step 6 of the
        prompt — a hang-up straight after "you're all set" is common and must
        not lose the outcome.
      */
      /*
        An upsert, not an insert, and the reason is subtle enough to be worth
        stating. `enquiries.call_id` is UNIQUE, so a second `book_appointment`
        on one Call would violate *this* constraint a moment before
        `tool_invocations_one_new_booking_per_call` gets to refuse it — and
        `runTool` would then report a generic error rather than "you're already
        booked in". Both roll the transaction back, so nothing is written either
        way; the difference is entirely in what Maya says next, which is the
        part the caller experiences.
      */
      await tx
        .insert(schema.enquiries)
        .values({
          callId: context.callId,
          kind: "booked",
          callerName,
          callerPhoneE164: parsed.value,
          topic: `Booked ${service.name} for ${spoken}.`,
          appointmentId: created.id,
          // Nothing for a human to do. They booked; it is in the diary.
          resolved: true,
        })
        .onConflictDoUpdate({
          target: schema.enquiries.callId,
          set: {
            kind: "booked",
            callerName,
            callerPhoneE164: parsed.value,
            topic: `Booked ${service.name} for ${spoken}.`,
            appointmentId: created.id,
            resolved: true,
          },
        });

      return {
        succeeded: true,
        result: { ok: true, booked_time: spoken, say: COMMITTED.booked(spoken) },
      };
    } catch (error) {
      /*
        Only the exclusion constraint is a lost race. Anything else is a real
        failure and belongs in `runTool`'s catch, which records it and hands
        Maya a line that promises nothing.
      */
      if (!isSlotTaken(error)) throw error;

      // SPEC.md §8 step 1: try once more without saying anything. The winner may
      // itself have rolled back, and a silent retry costs one statement.
    }
  }

  /*
    No Appointment was created, so there is no row to flag — unlike `book_slot`,
    which has an existing Appointment to mark `book_failed`. The Enquiry is the
    equivalent record, and it is left unresolved so a human sees that somebody
    tried to book and could not.
  */
  const wanted = `Wanted ${service.name} at ${spokenTime(startsAt, context.timezone)}, but the slot was taken.`;

  await tx
    .insert(schema.enquiries)
    .values({
      callId: context.callId,
      kind: "callback",
      callerName,
      callerPhoneE164: parsed.value,
      topic: wanted,
      resolved: false,
    })
    .onConflictDoUpdate({
      target: schema.enquiries.callId,
      set: { kind: "callback", callerName, topic: wanted, resolved: false },
    });

  return refuse("slot_taken");
};
