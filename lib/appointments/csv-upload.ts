import { createAppointment } from "@/lib/appointments/create";
import {
  MAX_CSV_ROWS,
  parseCsvRow,
  type CsvRow,
  type CsvRowRejection,
  type CsvUploadReport,
} from "@/lib/appointments/csv-input";
import { listServices } from "@/lib/business/list-services";

/**
 * Run one uploaded CSV (issue #8).
 *
 * Every row goes through `createAppointment` — the same function the quick-add
 * card calls, unchanged and not copied. That is the point of the file: one set
 * of rules for "can this Appointment exist", not a strict one for the form and a
 * looser one for bulk.
 *
 * **Rows are awaited one at a time, never `Promise.all`.** Two reasons. The
 * report has to be deterministic — the same file must always produce the same
 * list. And sequential inserts are what make the second row targeting a Slot
 * lose to the first cleanly, rather than by whichever query happened to reach
 * Postgres first.
 *
 * **Nothing here asks whether a Slot is free before inserting, and nothing
 * should be added that does** — not even for two rows in the same file, where it
 * looks like there is no race to lose. `appointments_no_overlap` is the only
 * judge (SPEC.md §3 rule 8). `lib/availability/book.ts` and
 * `lib/appointments/create.ts` say the same thing at their own layers, and the
 * reason is the same at all three: a second code path that also reports
 * "occupied" makes the constraint look redundant, and the next person to read
 * the file deletes the branch that handles the insert failing.
 *
 * `created` below is the one thing that looks like an exception and is not. It
 * records ranges **after** Postgres has accepted them, and it is read **after**
 * Postgres has refused one — purely to pick which sentence to print. Delete it
 * and the behaviour is identical; only the wording gets worse. That is the
 * property that stops it turning into a pre-check.
 */

/**
 * The two refusals `createAppointment` can give that are not about the Slot
 * being occupied.
 *
 * `not_offered` covers two problems at once — the Business is closed then, and
 * the time is inside opening hours but off the Slot grid, like 09:07 when Slots
 * run on the hour. The wording names both, because a CSV has no picker to have
 * offered a valid time in the first place.
 */
const REFUSALS: Record<"not_offered" | "in_the_past", string> = {
  not_offered:
    "That is not a time you can book. Check your business hours and the service length.",
  in_the_past: "That time has already passed.",
};

export type UploadCsvRowsInput = {
  businessId: string;
  /** The Business's IANA zone. CSV times are wall-clock in it. */
  timezone: string;
  rows: CsvRow[];
  /** Injected rather than read, so tests do not depend on the day they run. */
  now?: Date;
};

/** A range this run created, kept only to word a refusal Postgres has issued. */
type CreatedRange = {
  rowNumber: number;
  startsAt: number;
  endsAt: number;
  /** Carried so the Server Action can push this row to Google (issue #20). */
  id: string;
};

export async function uploadCsvRows({
  businessId,
  timezone,
  rows,
  now = new Date(),
}: UploadCsvRowsInput): Promise<CsvUploadReport> {
  /*
    Thrown, not returned. The browser refuses an oversized file and so does the
    Server Action, so arriving here with 201 rows means a caller ignored both —
    a programming error, not something a person needs rendered at them.
  */
  if (rows.length > MAX_CSV_ROWS) {
    throw new Error(`At most ${MAX_CSV_ROWS} rows, got ${rows.length}`);
  }

  /*
    Loaded once for the file, not once per row. The Service list is the only
    thing per-row validation needs from the database, which is why
    `parseCsvRow` takes it as an argument rather than reading it.
  */
  const services = await listServices(businessId);

  const rejected: CsvRowRejection[] = [];
  const created: CreatedRange[] = [];
  let skipped = 0;

  for (const row of rows) {
    const parsed = parseCsvRow(row, { services, timezone });

    if (parsed.status === "blank") {
      skipped++;
      continue;
    }

    if (parsed.status === "rejected") {
      rejected.push(reject(row, parsed.reasons));
      continue;
    }

    const result = await createAppointment({
      businessId,
      serviceId: parsed.value.serviceId,
      name: parsed.value.name,
      phoneE164: parsed.value.phoneE164,
      startsAt: parsed.value.startsAt,
      now,
    });

    if (result.ok) {
      created.push({
        id: result.appointment.id,
        rowNumber: row.rowNumber,
        startsAt: result.appointment.startsAt.getTime(),
        endsAt: result.appointment.endsAt.getTime(),
      });
      continue;
    }

    if (result.reason !== "slot_taken") {
      rejected.push(reject(row, [REFUSALS[result.reason]]));
      continue;
    }

    /*
      Postgres has already refused this row. All that is left to decide is which
      sentence to print, and that is the only thing the code below does.

      Ranges, not start times: a 120-minute Colour at 10:00 runs to 12:00, so an
      11:00 Haircut collides with it without sharing a start. Comparing starts
      alone would find nobody and fall through to "someone already has that
      time", which would be wrong — it was row 3, in this same upload.

      The end time is derived the way `bookSlot` derives it, start plus the
      Service duration in absolute milliseconds, and is used for nothing else.
    */
    const start = parsed.value.startsAt.getTime();
    const duration =
      services.find((service) => service.id === parsed.value.serviceId)
        ?.durationMinutes ?? 0;
    const end = start + duration * 60_000;

    // Two ranges overlap when each begins before the other ends. Half-open, so a
    // Slot ending at exactly 10:00 does not collide with one starting there —
    // the same rule `tstzrange` applies inside the constraint itself.
    const clash = created.find(
      (range) => range.startsAt < end && range.endsAt > start,
    );

    rejected.push(
      reject(row, [
        clash
          ? `Row ${clash.rowNumber} already takes that time.`
          : "Someone already has that time.",
      ]),
    );
  }

  return {
    created: created.length,
    createdIds: created.map((row) => row.id),
    rejected,
    skipped,
  };
}

function reject(row: CsvRow, reasons: string[]): CsvRowRejection {
  // An em dash rather than an empty string, so a row missing its name is still a
  // recognisable line in the report rather than a gap the eye slides past.
  return { rowNumber: row.rowNumber, name: row.name.trim() || "—", reasons };
}
