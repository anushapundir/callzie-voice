import Papa from "papaparse";

import {
  checkColumns,
  MAX_CSV_ROWS,
  type CsvRow,
} from "@/lib/appointments/csv-input";

/**
 * A CSV file's text turned into rows (issue #8).
 *
 * This is the client-side half of the upload. SPEC.md §2 fixes PapaParse and
 * puts parsing in the browser, so this module runs there — but it is kept out of
 * the component so it can be tested without one. The repo has no component
 * tests, and the numbering rule below is exactly the kind of thing that breaks
 * silently and is then only noticed by someone comparing a report against their
 * spreadsheet.
 *
 * **None of this is a security boundary.** Every check here is repeated in
 * `uploadCsvAction`, because a Server Action is a POST anyone can send. What
 * this buys is a round trip: a file with the wrong columns is refused before it
 * is uploaded, not after.
 *
 * **Row numbers are file line numbers.** The header is line 1, so the first data
 * row is 2. That is what makes the report usable — "Row 4" has to mean the
 * fourth line of the file the person is looking at, or it sends them to the
 * wrong row.
 */

export type ParsedCsvFile =
  | { ok: true; rows: CsvRow[] }
  | { ok: false; message: string };

export function parseCsvFile(text: string): ParsedCsvFile {
  if (text.trim().length === 0) {
    return { ok: false, message: "That file is empty." };
  }

  const parsed = Papa.parse<Record<string, string | undefined>>(text, {
    header: true,
    /*
      Blank lines are kept, not skipped. An interior blank line has to hold its
      row number so every row below it still matches the spreadsheet; dropping
      it here would shift the whole report by one and send someone to the wrong
      line. The server counts them as `skipped` and never reports them.
    */
    skipEmptyLines: false,
  });

  /*
    An unclosed quote is the one PapaParse error worth failing the whole file
    over: everything after the stray `"` is swallowed into a single field, so the
    rows below it are not wrong, they are gone. There is no honest per-row report
    to give.

    Nothing else here is fatal, and two near-misses are worth naming because both
    were tried and both were wrong:

    - **TooFewFields / TooManyFields** are per-row and ordinary. A row someone
      did not finish becomes a row with empty cells, which the per-row report
      already has messages for. Failing the file would refuse everything above
      and below over one unfinished line.

    - **UndetectableDelimiter** looks fatal and is not. PapaParse raises it for a
      header followed by blank lines — a file that parses perfectly well — and
      answering that with "check for an unclosed quote" sends someone hunting for
      a quote that was never there. When the delimiter genuinely cannot be found,
      the columns do not resolve either, and `checkColumns` below says so in
      words that name the actual problem.
  */
  const unreadable = parsed.errors.some(
    (error) => error.code === "MissingQuotes",
  );
  if (unreadable) {
    return {
      ok: false,
      message: "That file could not be read as CSV. Check for an unclosed quote.",
    };
  }

  const columns = checkColumns(parsed.meta.fields ?? []);
  if (!columns.ok) {
    return { ok: false, message: columns.message };
  }

  const data = dropTrailingBlanks(parsed.data);

  if (data.length === 0) {
    return {
      ok: false,
      message: "That file has a header row and nothing under it.",
    };
  }

  if (data.length > MAX_CSV_ROWS) {
    return {
      ok: false,
      message:
        `That file has ${data.length} rows. ` +
        `Upload at most ${MAX_CSV_ROWS} at a time.`,
    };
  }

  return {
    ok: true,
    rows: data.map((raw, index) => ({
      rowNumber: index + 2, // the header is line 1
      name: raw[columns.map.name] ?? "",
      phone: raw[columns.map.phone] ?? "",
      service: raw[columns.map.service] ?? "",
      time: raw[columns.map.time] ?? "",
    })),
  };
}

/**
 * Blank rows at the end of the file, dropped.
 *
 * A trailing newline is not a line anyone typed — every well-formed CSV has one,
 * and counting it would make a clean three-row file report one skipped row.
 * Blank lines in the *middle* survive, because those are the ones whose row
 * numbers everything below depends on.
 */
function dropTrailingBlanks(
  rows: Record<string, string | undefined>[],
): Record<string, string | undefined>[] {
  let end = rows.length;
  while (end > 0 && isBlank(rows[end - 1])) end--;
  return rows.slice(0, end);
}

function isBlank(row: Record<string, string | undefined>): boolean {
  return Object.values(row).every((cell) => (cell ?? "").trim().length === 0);
}
