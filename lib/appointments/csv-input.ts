import { parseE164 } from "@/lib/appointments/phone";
import { MAX_NAME_LENGTH } from "@/lib/appointments/quick-add-input";
import type { ServiceOption } from "@/lib/business/list-services";
import { tryParseWallClock, zonedTimeToInstant } from "@/lib/time/zone";

/**
 * What a CSV upload accepts, and what it reports back (issue #8).
 *
 * Shaped like `lib/appointments/quick-add-input.ts` and for the same reasons: a
 * hand-written parser returning a discriminated result, with the state types
 * beside it because a `"use server"` module may export nothing but async
 * functions.
 *
 * **Nothing here touches the database.** The Business's Services and its
 * timezone are passed in, which does two things: it makes the whole of per-row
 * validation testable without a database, and it forces the caller to load them
 * once for the file rather than once for every row.
 *
 * A Server Action is a POST reachable by anyone who can send it
 * (`node_modules/next/dist/docs/01-app/02-guides/server-actions.md`,
 * "Security"). The browser parses the file — SPEC.md §2 puts PapaParse
 * client-side — but nothing it decided about the contents is trusted here. Every
 * rule below runs on the server, every time.
 */

/**
 * The four columns a file must carry. Extra columns are ignored, so a sheet
 * someone already keeps for their own purposes can be uploaded as it is.
 */
export const CSV_COLUMNS = ["name", "phone", "service", "time"] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];

/**
 * Rows accepted in one upload.
 *
 * A bound on cost, not on correctness. Every row runs `createAppointment`
 * unchanged, which reloads the Business's schedule each time — roughly five
 * queries a row. Hoisting that out of the loop would be faster and would mean
 * the CSV path stops running the identical code the quick-add card runs, which
 * is the one property this feature will not trade away. So the loop stays
 * untuned and the file size is capped instead.
 */
export const MAX_CSV_ROWS = 200;

/** One data row, carrying the line of the file it came from. */
export type CsvRow = {
  /**
   * The line number the person sees in their spreadsheet. The header is line 1,
   * so the first data row is 2. Carried rather than derived because the report
   * has to send them to the right row of the file they are looking at.
   */
  rowNumber: number;
  name: string;
  phone: string;
  service: string;
  time: string;
};

export type CsvRowRejection = {
  rowNumber: number;
  /** Shown beside the number so the row is recognisable. "—" when blank. */
  name: string;
  /** Every problem with this row, not just the first. */
  reasons: string[];
};

export type CsvUploadReport = {
  created: number;
  /**
   * The Appointments this upload created.
   *
   * Not for display — nothing renders these. They exist so the Server Action
   * can push each new Appointment to Google Calendar after the response
   * (ADR-0004, issue #20), which needs an id per row rather than a count.
   */
  createdIds: string[];
  rejected: CsvRowRejection[];
  /**
   * Fully blank lines. Counted, never reported — a trailing newline is not a
   * mistake worth telling someone about, and an interior blank line still has to
   * hold its row number so every row after it keeps matching the spreadsheet.
   */
  skipped: number;
};

/**
 * `file_error` is for a problem with no row to hang it on — an empty file, a
 * missing column. It renders inside the upload sheet, where the file was picked.
 *
 * Everything per-row travels in `report` and renders in the persistent panel on
 * Overview, because SPEC.md §11.4 wants inline persistent UI for anything
 * requiring action, and a rejected row is the definition of that.
 */
export type CsvUploadState =
  | { status: "idle" }
  | { status: "file_error"; message: string }
  | { status: "done"; report: CsvUploadReport };

export const INITIAL_CSV_UPLOAD_STATE: CsvUploadState = { status: "idle" };

/** Canonical column name → the header exactly as the file wrote it. */
export type ColumnMap = Record<CsvColumn, string>;

export type CheckedColumns =
  | { ok: true; map: ColumnMap }
  | { ok: false; message: string };

/**
 * Whether a header row carries the four columns — matched by name, not by
 * position.
 *
 * Case and surrounding spaces are ignored, because a spreadsheet adds both.
 * Order does not matter, because nobody keeps their columns in someone else's
 * order.
 *
 * The map hands each header back **as written**. PapaParse keys every row by the
 * literal header string, so the caller needs the original to read the row, not
 * the normalised form used to match it.
 *
 * Two headers that normalise to the same name are refused rather than resolved.
 * Whichever one lost would be silently dropped along with everything the person
 * typed into it.
 */
export function checkColumns(headers: string[]): CheckedColumns {
  const map: Partial<ColumnMap> = {};

  for (const header of headers) {
    const normalised = header.trim().toLowerCase();
    const column = CSV_COLUMNS.find((candidate) => candidate === normalised);
    if (!column) continue;

    if (map[column] !== undefined) {
      return {
        ok: false,
        message: `That file has two columns called "${column}". Keep one.`,
      };
    }
    map[column] = header;
  }

  const missing = CSV_COLUMNS.filter((column) => map[column] === undefined);
  if (missing.length > 0) {
    /*
      What was found, not what was missing. Someone whose columns read
      "forename, mobile" already knows they did not write "name" — what they need
      is to see the two lists side by side and spot which of their own headings
      is the wrong one.
    */
    const found = headers.length > 0 ? headers.join(", ") : "nothing";
    return {
      ok: false,
      message:
        "That file needs columns named name, phone, service and time. " +
        `Found: ${found}.`,
    };
  }

  return { ok: true, map: map as ColumnMap };
}

export type CsvRowContext = {
  /** The Business's own Services. A name in the file is resolved against these. */
  services: ServiceOption[];
  /** IANA zone from `businesses.timezone`. The file carries no offset. */
  timezone: string;
};

export type CsvRowValue = {
  name: string;
  phoneE164: string;
  serviceId: string;
  startsAt: Date;
};

export type ParsedCsvRow =
  | { status: "ok"; value: CsvRowValue }
  | { status: "rejected"; reasons: string[] }
  | { status: "blank" };

/**
 * One CSV row, validated against this Business's Services and timezone.
 *
 * **Every problem is reported, not just the first.** A row with a bad phone
 * number and an unknown service comes back carrying both. Stopping at the first
 * would make one upload take two passes to fix, and a per-row report exists
 * precisely so that it takes one. Same rule the quick-add form already follows.
 *
 * **The phone validator's wording is reused word for word**, so a bad number
 * reads the same here as it does in the quick-add card. `lib/appointments/phone.ts`
 * promised this feature exactly that in its own header comment.
 *
 * **`serviceId` is never read from the file.** The CSV carries a Service *name*,
 * resolved against this Business's Services, so there is no id in the file for
 * anyone to forge.
 *
 * The time is a wall clock with no offset — see `tryParseWallClock`. Turning it
 * into an instant needs the Business's zone, which is why `timezone` is part of
 * the context rather than something the row carries.
 */
export function parseCsvRow(
  row: CsvRow,
  { services, timezone }: CsvRowContext,
): ParsedCsvRow {
  const name = row.name.trim();
  const phone = row.phone.trim();
  const service = row.service.trim();
  const time = row.time.trim();

  /*
    A line with nothing on it.

    Reported as blank rather than as four errors, because the file is parsed with
    `skipEmptyLines: false` — an interior blank line has to keep its row number
    so every row below it still matches what the person sees in their
    spreadsheet. Complaining about it would fill the report with noise nobody
    caused.
  */
  if (!name && !phone && !service && !time) return { status: "blank" };

  const reasons: string[] = [];

  if (name.length === 0) {
    reasons.push("Enter the person's name.");
  } else if (name.length > MAX_NAME_LENGTH) {
    reasons.push(`Keep the name under ${MAX_NAME_LENGTH} characters.`);
  }

  let phoneE164 = "";
  const parsedPhone = parseE164(phone);
  if (parsedPhone.ok) {
    phoneE164 = parsedPhone.value;
  } else {
    reasons.push(parsedPhone.error);
  }

  let serviceId = "";
  if (service.length === 0) {
    reasons.push("Enter a service.");
  } else {
    const matches = services.filter(
      (candidate) => candidate.name.trim().toLowerCase() === service.toLowerCase(),
    );

    if (matches.length === 1) {
      serviceId = matches[0].id;
    } else if (matches.length > 1) {
      /*
        Nothing stops a Business having two Services with the same name —
        `lib/settings/services-input.ts` checks the name's length and nothing
        else. Picking one would book an Appointment of an unknown length, and
        the Slot grid is the Service duration, so the person would have no way
        to tell which they got. This asks instead of guessing.
      */
      reasons.push(`Two services are called "${service}". Rename one in Settings.`);
    } else {
      // The known names are listed because the usual cause is a typo, and a
      // typo is only obvious next to the word it was meant to be.
      const known = services.map((candidate) => candidate.name).join(", ");
      reasons.push(`No service called "${service}". Known services: ${known}.`);
    }
  }

  let startsAt = new Date(Number.NaN);
  if (time.length === 0) {
    reasons.push("Enter a time.");
  } else {
    const wall = tryParseWallClock(time);
    if (!wall) {
      // The message is the format itself. "Invalid date" tells someone their
      // value was wrong; this tells them what a right one looks like.
      reasons.push("Write the time as 2026-08-21 09:30.");
    } else {
      // The file carries no offset, so the zone comes from the Business. See
      // ADR-0007 for how a DST gap and an ambiguous hour each resolve.
      startsAt = zonedTimeToInstant(wall, timezone);
    }
  }

  if (reasons.length > 0) return { status: "rejected", reasons };

  return { status: "ok", value: { name, phoneE164, serviceId, startsAt } };
}
