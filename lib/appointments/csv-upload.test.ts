import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseCsvFile } from "@/lib/appointments/csv-file";
import type { CsvRow } from "@/lib/appointments/csv-input";
import { uploadCsvRows } from "@/lib/appointments/csv-upload";
import { provisionUser } from "@/lib/auth/provision-user";
import { db, schema } from "@/lib/db";

const CLERK_ID = "user_test_csv_upload";
const TIMEZONE = "Asia/Kolkata";

/** Sunday 16 August 2026. Monday the 17th is the first open day after it. */
const NOW = new Date("2026-08-16T00:00:00.000Z");

let businessId: string;

async function cleanup() {
  const user = await db.query.users.findFirst({
    where: eq(schema.users.clerkId, CLERK_ID),
  });
  if (!user) return;

  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.userId, user.id),
  });
  if (business) {
    await db
      .delete(schema.appointments)
      .where(eq(schema.appointments.businessId, business.id));
    await db
      .delete(schema.services)
      .where(eq(schema.services.businessId, business.id));
    await db
      .delete(schema.businessHours)
      .where(eq(schema.businessHours.businessId, business.id));
    await db.delete(schema.businesses).where(eq(schema.businesses.id, business.id));
  }
  await db.delete(schema.users).where(eq(schema.users.clerkId, CLERK_ID));
}

beforeEach(async () => {
  await cleanup();
  const user = await provisionUser(CLERK_ID, "csv@example.com");

  const [business] = await db
    .insert(schema.businesses)
    .values({
      userId: user.id,
      name: "CSV Test Salon",
      businessType: "salon",
      timezone: TIMEZONE,
    })
    .returning();
  businessId = business.id;

  await db.insert(schema.businessHours).values(
    [1, 2, 3, 4, 5].map((weekday) => ({
      businessId,
      weekday,
      opensAt: "09:00",
      closesAt: "17:00",
    })),
  );

  await db
    .insert(schema.services)
    .values({ businessId, name: "Haircut", durationMinutes: 60 });
});

afterEach(cleanup);

function row(rowNumber: number, time: string, name = `Person ${rowNumber}`): CsvRow {
  return {
    rowNumber,
    name,
    phone: "+12025550110",
    service: "Haircut",
    time: `2026-08-17 ${time}`,
  };
}

function upload(rows: CsvRow[]) {
  return uploadCsvRows({ businessId, timezone: TIMEZONE, rows, now: NOW });
}

async function appointmentCount() {
  const rows = await db
    .select()
    .from(schema.appointments)
    .where(eq(schema.appointments.businessId, businessId));
  return rows.length;
}

describe("uploadCsvRows", () => {
  it("creates every row of a valid file and counts them", async () => {
    const report = await upload([row(2, "09:00"), row(3, "10:00"), row(4, "11:00")]);

    expect(report).toMatchObject({ created: 3, rejected: [], skipped: 0 });
    // One id per created row, so the Server Action can push each to Google.
    expect(report.createdIds).toHaveLength(3);
    expect(await appointmentCount()).toBe(3);
  });

  it("creates the good rows and reports the bad ones by spreadsheet row number", async () => {
    const report = await upload([
      row(2, "09:00"),
      { ...row(3, "10:00"), phone: "9820012345" },
      // A blank line at row 4. It must not renumber row 5.
      { rowNumber: 4, name: "", phone: "", service: "", time: "" },
      { ...row(5, "11:00"), service: "Massage" },
      row(6, "11:00"),
      row(7, "12:00"),
    ]);

    expect(report.created).toBe(3);
    expect(report.skipped).toBe(1);
    expect(report.rejected.map((r) => r.rowNumber)).toEqual([3, 5]);
    expect(report.rejected[0].name).toBe("Person 3");
    expect(report.rejected[0].reasons).toEqual([
      "Start with the country code, like +44 or +91.",
    ]);
    expect(report.rejected[1].reasons).toEqual([
      'No service called "Massage". Known services: Haircut.',
    ]);
    expect(await appointmentCount()).toBe(3);
  });

  it("lets only one of two rows targeting the same Slot be created", async () => {
    /*
      The acceptance criterion, and the test that protects the design.

      Row 2 wins because it is attempted first. Row 4 loses because Postgres
      refused the insert — `appointments_no_overlap` — and not because anything
      in uploadCsvRows looked first. A pre-check reintroduced there would change
      which row wins, or stop the constraint being the thing that decides, and
      this fails either way.

      The wording is the second half of the test. "Someone already has that
      time" would be a lie here: nobody else did. Row 2 did, a moment ago, in
      this same file.
    */
    const report = await upload([row(2, "09:00"), row(3, "10:00"), row(4, "09:00")]);

    expect(report.created).toBe(2);
    expect(report.rejected).toEqual([
      {
        rowNumber: 4,
        name: "Person 4",
        reasons: ["Row 2 already takes that time."],
      },
    ]);
    expect(await appointmentCount()).toBe(2);
  });

  it("names the earlier row when the two Slots only overlap", async () => {
    /*
      Two rows can collide without sharing a start. A 120-minute Colour at 09:00
      runs to 11:00, so a 10:00 Haircut lands inside it and the constraint
      refuses the row. Comparing start times alone would find nobody and fall
      through to "someone already has that time", which would be wrong — it was
      row 2, in this same upload.

      Note the Colour starts at 09:00 and not 10:00. Slot size is the Service
      duration, so a 120-minute Colour is offered at 09:00, 11:00, 13:00 and
      15:00 — 10:00 is not on its grid at all, and would be refused before the
      constraint ever saw it.
    */
    await db
      .insert(schema.services)
      .values({ businessId, name: "Colour", durationMinutes: 120 });

    const report = await upload([
      { ...row(2, "09:00"), service: "Colour" },
      row(3, "10:00"),
      row(4, "11:00"),
    ]);

    expect(report.created).toBe(2);
    expect(report.rejected).toHaveLength(1);
    expect(report.rejected[0].rowNumber).toBe(3);
    expect(report.rejected[0].reasons).toEqual(["Row 2 already takes that time."]);
  });

  it("says someone already has the time when the holder is not in this file", async () => {
    expect((await upload([row(2, "09:00")])).created).toBe(1);

    const report = await upload([row(2, "09:00", "Someone Else")]);

    expect(report.created).toBe(0);
    expect(report.rejected[0].reasons).toEqual(["Someone already has that time."]);
  });

  it("refuses a time outside Business Hours and a time already past", async () => {
    const report = await upload([
      row(2, "03:00"),
      { ...row(3, "09:00"), time: "2026-08-10 09:00" },
    ]);

    expect(report.created).toBe(0);
    expect(report.rejected[0].reasons).toEqual([
      "That is not a time you can book. Check your business hours and the service length.",
    ]);
    expect(report.rejected[1].reasons).toEqual(["That time has already passed."]);
  });

  it("refuses a file over the row cap without creating anything", async () => {
    // Reachable only by a caller that ignored both the browser's check and the
    // Server Action's, so it throws rather than returning something to render.
    const rows = Array.from({ length: 201 }, (_, i) => row(i + 2, "09:00"));

    await expect(upload(rows)).rejects.toThrow(/200/);
    expect(await appointmentCount()).toBe(0);
  });

  it("creates nothing and reports nothing for a file of blank lines", async () => {
    const report = await upload([
      { rowNumber: 2, name: "", phone: "", service: "", time: "" },
      { rowNumber: 3, name: "", phone: "", service: "", time: "" },
    ]);

    expect(report).toEqual({ created: 0, createdIds: [], rejected: [], skipped: 2 });
  });
});

/**
 * The acceptance criteria of issue #8, driven from literal CSV text.
 *
 * `uploadCsvRows` above is tested against rows someone else already built. This
 * block starts where a person does — with the contents of a file — and runs the
 * real client-side parse into the real database write. It is the closest thing
 * to the browser walkthrough that can run unattended, and it is what catches a
 * mistake that lives in the seam between the two halves rather than in either.
 */
describe("a CSV, end to end", () => {
  const HEADER = "name,phone,service,time";

  function run(...lines: string[]) {
    const parsed = parseCsvFile([HEADER, ...lines].join("\n"));
    if (!parsed.ok) throw new Error(`file refused: ${parsed.message}`);
    return upload(parsed.rows);
  }

  it("creates every row of a valid file and reports the count", async () => {
    const report = await run(
      "Priya Raman,+1 202 555 0110,Haircut,2026-08-17 09:00",
      "Daniel Okafor,+12025550111,haircut,2026-08-17 10:00",
      "Mei Lin,+1 (202) 555-0112,HAIRCUT,2026-08-17 11:00",
    );

    expect(report).toMatchObject({ created: 3, rejected: [], skipped: 0 });
    // One id per created row, so the Server Action can push each to Google.
    expect(report.createdIds).toHaveLength(3);

    const rows = await db
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.businessId, businessId));
    expect(rows).toHaveLength(3);
    // Stored as E.164 regardless of how it was written (SPEC.md §3 rule 10).
    expect(rows.map((row) => row.phoneE164).sort()).toEqual([
      "+12025550110",
      "+12025550111",
      "+12025550112",
    ]);
    // 09:00 Asia/Kolkata is +05:30, and ends_at comes from the Service duration.
    const first = rows.find((row) => row.name === "Priya Raman");
    expect(first?.startsAt.toISOString()).toBe("2026-08-17T03:30:00.000Z");
    expect(first?.endsAt.toISOString()).toBe("2026-08-17T04:30:00.000Z");
  });

  it("creates the valid rows and lists each rejected one with its row number", async () => {
    const report = await run(
      "Priya Raman,+12025550110,Haircut,2026-08-17 09:00", // row 2, created
      "Daniel Okafor,9820012345,Haircut,2026-08-17 10:00", // row 3, bad phone
      "", //                                                  row 4, blank
      "Mei Lin,+12025550112,Massage,2026-08-17 10:00", //      row 5, no such service
      "Tomas Guerrero,+12025550113,Haircut,2026-08-17 03:00", // row 6, closed then
      ",+12025550114,Haircut,tuesday", //                      row 7, two problems
      "Aisha Bello,+12025550115,Haircut,2026-08-17 10:00", //  row 8, created
    );

    expect(report.created).toBe(2);
    expect(report.skipped).toBe(1);
    expect(report.rejected).toEqual([
      {
        rowNumber: 3,
        name: "Daniel Okafor",
        reasons: ["Start with the country code, like +44 or +91."],
      },
      {
        rowNumber: 5,
        name: "Mei Lin",
        reasons: ['No service called "Massage". Known services: Haircut.'],
      },
      {
        rowNumber: 6,
        name: "Tomas Guerrero",
        reasons: [
          "That is not a time you can book. Check your business hours and the service length.",
        ],
      },
      {
        // No name in the file, so the report still has something to show.
        rowNumber: 7,
        name: "—",
        reasons: [
          "Enter the person's name.",
          "Write the time as 2026-08-21 09:30.",
        ],
      },
    ]);
  });

  it("cannot create two rows targeting the same Slot", async () => {
    const report = await run(
      "Priya Raman,+12025550110,Haircut,2026-08-17 09:00",
      "Daniel Okafor,+12025550111,Haircut,2026-08-17 09:00",
    );

    expect(report.created).toBe(1);
    expect(report.rejected).toEqual([
      {
        rowNumber: 3,
        name: "Daniel Okafor",
        reasons: ["Row 2 already takes that time."],
      },
    ]);
    expect(await appointmentCount()).toBe(1);
  });

  it("refuses a malformed or empty file with a designed message", async () => {
    // Each of these is a sentence someone can act on, and none of them is an
    // exception reaching the screen.
    expect(parseCsvFile("")).toEqual({
      ok: false,
      message: "That file is empty.",
    });
    expect(parseCsvFile(HEADER)).toEqual({
      ok: false,
      message: "That file has a header row and nothing under it.",
    });
    expect(parseCsvFile("forename,mobile\nPriya,+12025550110")).toEqual({
      ok: false,
      message:
        "That file needs columns named name, phone, service and time. " +
        "Found: forename, mobile.",
    });
    expect(parseCsvFile('name,phone,service,time\n"Priya,+1,Haircut,x')).toEqual({
      ok: false,
      message: "That file could not be read as CSV. Check for an unclosed quote.",
    });
  });
});
