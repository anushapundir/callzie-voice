import { describe, expect, it } from "vitest";

import { parseCsvFile } from "@/lib/appointments/csv-file";

const HEADER = "name,phone,service,time";

function file(...lines: string[]): string {
  return [HEADER, ...lines].join("\n");
}

describe("parseCsvFile", () => {
  it("turns a well-formed file into rows numbered from 2", () => {
    const result = parseCsvFile(
      file(
        "Priya Raman,+1 202 555 0110,Cleaning,2026-08-21 09:30",
        "Daniel Okafor,+12025550111,Check-up,2026-08-21 10:00",
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toEqual([
      {
        rowNumber: 2,
        name: "Priya Raman",
        phone: "+1 202 555 0110",
        service: "Cleaning",
        time: "2026-08-21 09:30",
      },
      {
        rowNumber: 3,
        name: "Daniel Okafor",
        phone: "+12025550111",
        service: "Check-up",
        time: "2026-08-21 10:00",
      },
    ]);
  });

  it("keeps a blank line in the middle so the rows below it keep their numbers", () => {
    // The whole point of the report is that "Row 5" means line 5 of the file
    // the person is looking at. Skipping the blank would make it mean line 4.
    const result = parseCsvFile(
      file(
        "Priya Raman,+12025550110,Cleaning,2026-08-21 09:30",
        "",
        "Mei Lin,+12025550112,Consultation,2026-08-21 11:00",
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.map((row) => row.rowNumber)).toEqual([2, 3, 4]);
    expect(result.rows[1].name).toBe("");
    expect(result.rows[2].name).toBe("Mei Lin");
  });

  it("drops a trailing newline rather than counting it as a row", () => {
    // Every well-formed CSV ends with one. Counting it would make a clean
    // two-row file report a skipped row nobody caused.
    const result = parseCsvFile(
      file("Priya Raman,+12025550110,Cleaning,2026-08-21 09:30") + "\n",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(1);
  });

  it("reads columns in any order and any case, ignoring extras", () => {
    const result = parseCsvFile(
      [
        "Notes,TIME,Service, Phone ,Name",
        "call after 5,2026-08-21 09:30,Cleaning,+12025550110,Priya Raman",
      ].join("\n"),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]).toEqual({
      rowNumber: 2,
      name: "Priya Raman",
      phone: "+12025550110",
      service: "Cleaning",
      time: "2026-08-21 09:30",
    });
  });

  it("keeps a quoted comma inside one field", () => {
    const result = parseCsvFile(
      file('"Raman, Priya",+12025550110,Cleaning,2026-08-21 09:30'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].name).toBe("Raman, Priya");
  });

  it("does not fail a whole file over one short row", () => {
    // A row someone did not finish is a per-row problem with its own message,
    // not a reason to refuse everything above and below it.
    const result = parseCsvFile(
      file(
        "Priya Raman,+12025550110,Cleaning,2026-08-21 09:30",
        "Daniel Okafor,+12025550111",
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(2);
    expect(result.rows[1]).toEqual({
      rowNumber: 3,
      name: "Daniel Okafor",
      phone: "+12025550111",
      service: "",
      time: "",
    });
  });

  it("refuses an empty file", () => {
    expect(parseCsvFile("")).toEqual({
      ok: false,
      message: "That file is empty.",
    });
    expect(parseCsvFile("   \n  ")).toEqual({
      ok: false,
      message: "That file is empty.",
    });
  });

  it("refuses a file with a header and nothing under it", () => {
    expect(parseCsvFile(HEADER)).toEqual({
      ok: false,
      message: "That file has a header row and nothing under it.",
    });
    expect(parseCsvFile(HEADER + "\n\n\n")).toEqual({
      ok: false,
      message: "That file has a header row and nothing under it.",
    });
  });

  it("refuses a file whose columns are named something else", () => {
    const result = parseCsvFile("forename,mobile\nPriya,+12025550110");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(
      "That file needs columns named name, phone, service and time. " +
        "Found: forename, mobile.",
    );
  });

  it("refuses a file over the row cap", () => {
    const rows = Array.from(
      { length: 201 },
      (_, i) => `Person ${i},+12025550110,Cleaning,2026-08-21 09:30`,
    );

    const result = parseCsvFile(file(...rows));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(
      "That file has 201 rows. Upload at most 200 at a time.",
    );
  });

  it("refuses a file with an unclosed quote", () => {
    const result = parseCsvFile(
      file('"Priya Raman,+12025550110,Cleaning,2026-08-21 09:30'),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(
      "That file could not be read as CSV. Check for an unclosed quote.",
    );
  });
});
