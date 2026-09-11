import { and, asc, eq, gt, inArray } from "drizzle-orm";

import { schema } from "@/lib/db";
import { SLOT_HOLDING_STATUSES } from "@/lib/db/schema";
import type { InboundToolContext } from "@/lib/tools/request";
import type { ToolHandler } from "@/lib/tools/run";
import { spokenTime } from "@/lib/tools/spoken-time";

/**
 * `lookup_appointment` — "when's my appointment?" (issue #43).
 *
 * **Matches on the number the caller is ringing from, and on nothing else.**
 * That is the whole security design of this Tool, and it is why the schema in
 * `lib/retell/tools.ts` takes no arguments at all.
 *
 * The alternative — accepting a name — is what a helpful assistant would do and
 * is exactly wrong. "I'm calling about Sarah's appointment" from an unknown
 * number would read a stranger's booking, their phone number and their treatment
 * out loud to whoever dialled. There is no version of that which is worth the
 * convenience, and no amount of prompt wording prevents it once the argument
 * exists.
 *
 * Returning nothing is a perfectly good outcome, and the prompt says so: Maya
 * tells them she cannot find one for this number and offers to take a message.
 * "You're booked for Tuesday" said to somebody who is not is worse than "I can't
 * find one" said to somebody who is.
 */

/** Nobody needs more than this read back on the phone. */
const MAX_RESULTS = 3;

export type FoundAppointment = {
  service: string;
  time: string;
  status: string;
};

export const lookupAppointmentTool: ToolHandler<InboundToolContext> = async ({
  tx,
  context,
  now,
}) => {
  /*
    A widget visitor has no number to match on (issue #45), so there is nothing
    to look up — not a degraded search, no search at all. Answering "I can't
    find one under this number" would be false in a way that matters: there is
    no number.

    `succeeded: true`, because this is a correct answer to a question Maya was
    right to ask. Recording it as a failure would have her promise a callback
    about something that worked.
  */
  if (context.fromNumber === null) {
    return {
      succeeded: true,
      result: {
        ok: true,
        appointments: [],
        say:
          "I can't look that up from here, but I can take your name and " +
          "number and have someone check.",
      },
    };
  }

  const rows = await tx
    .select({
      startsAt: schema.appointments.startsAt,
      status: schema.appointments.status,
      serviceName: schema.services.name,
    })
    .from(schema.appointments)
    .innerJoin(
      schema.services,
      eq(schema.appointments.serviceId, schema.services.id),
    )
    .where(
      and(
        // Scoped to this Business as well as this number. A caller who uses two
        // businesses on Callzie must not hear one's diary from the other.
        eq(schema.appointments.businessId, context.businessId),
        eq(schema.appointments.phoneE164, context.fromNumber),
        // Only ones still standing. A cancelled Appointment is not "your
        // appointment", and reading it back would sound like it is still on.
        inArray(schema.appointments.status, [...SLOT_HOLDING_STATUSES]),
        // And only ahead. Last month's visit is not what they are ringing about.
        gt(schema.appointments.startsAt, now),
      ),
    )
    .orderBy(asc(schema.appointments.startsAt))
    .limit(MAX_RESULTS);

  const appointments: FoundAppointment[] = rows.map((row) => ({
    service: row.serviceName,
    time: spokenTime(row.startsAt, context.timezone),
    status: row.status,
  }));

  /*
    `succeeded: true` with an empty list. Finding nothing is an answer, not a
    failure — recording it as one would have Maya promise a callback (SPEC.md §8)
    about a question she answered correctly.
  */
  return {
    succeeded: true,
    result: {
      ok: true,
      appointments,
      ...(appointments.length === 0
        ? {
            say:
              "I can't find an appointment under this number. " +
              "I can take a message, or book you in now.",
          }
        : {}),
    },
  };
};
