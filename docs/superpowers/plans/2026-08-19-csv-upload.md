# CSV upload with per-row validation: Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Upload a CSV of people on Overview, create every valid row, and show a
persistent list of the rejected rows — each with its spreadsheet row number and a specific
reason. Closes [#8](https://github.com/anushapundir/callzie/issues/8).

**Architecture:** Every row goes through the exact path quick-add uses — `parseE164` →
`createAppointment` → `slotIsOffered` → `bookSlot` — so there is one set of validation
rules, not two. The `appointments_no_overlap` EXCLUDE constraint stays the only thing that
decides a Slot is taken, **including when both competing rows come from the same file**;
the in-memory list of rows created this run exists only to choose the wording of a refusal
Postgres has already issued. Parsing is client-side with PapaParse (SPEC.md §2); all
validation is server-side, because a Server Action is a POST anyone can send.

**Tech Stack:** Next.js 16 App Router, TypeScript, Drizzle/Postgres, Tailwind + shadcn,
PapaParse, vitest against embedded Postgres.

**Design doc:** `docs/superpowers/specs/2026-08-19-csv-upload-design.md`

---

## Progress

Tasks 1–9 shipped. Task 10's automated half shipped; its browser half is
outstanding — see below.

| Task | Commit |
|---|---|
| 1 — `tryParseWallClock` | `d13dece` |
| 2 — `checkColumns` | `11edbfb` |
| 3 — `parseCsvRow` | `a34d0fc` |
| 4 — `uploadCsvRows` | `b9e0b82` |
| 5 — PapaParse | `0727884` |
| 6 — `uploadCsvAction` | `39c5126` |
| 7, 8, 9 — the screen | `7e0aac4` |
| `csv-file.ts` + the message fix | `8fd92dd` |
| End-to-end criteria | `49b08a3` |

**760 tests pass across 40 files.** `npm run typecheck`, `npm run lint` and
`npm run build` are all clean.

**Still outstanding: the browser walkthrough (Task 10).** Every app route sits
behind Clerk (`proxy.ts` protects by default), and this workspace has no
`.env.local`, so the app cannot be signed into. What that leaves unverified is
only the visual layer — how the panel and the sheet look at 375px, the focus
rings, Escape closing the sheet, and the panel surviving a `revalidatePath`.
Everything about *behaviour* is covered by the end-to-end tests below.

## Changes from the design doc

**`lib/appointments/csv-file.ts` is new and was not planned.** The design put the
PapaParse call inside the component, which left the file→rows path — the
`skipEmptyLines: false` numbering rule, the trailing-blank drop, the whole-file
refusals — as the one piece of real logic with no test, in a repo with no
component tests. It moved into a pure module with 11 tests of its own.

That immediately paid for itself: **a header followed by blank lines makes
PapaParse report `UndetectableDelimiter`**, which the planned code treated as
fatal, so a perfectly readable file was refused with "check for an unclosed
quote" — sending someone hunting for a quote that was never there, on the very
criterion about designed failure messages. Only `MissingQuotes` is fatal now; a
genuinely undelimitable file fails on its columns instead, which names the real
problem. Commit `8fd92dd`.

**`parseCsvRow` returns `{ status: "blank" }`, not `{ blank: true }`.** One
discriminant across all three outcomes rather than two shapes to narrow.

**Two test fixtures in the plan were wrong and were corrected while writing
them.** A "mixed file" case claimed three creations from two valid rows, and the
overlap case put a 120-minute Colour at 10:00 — which is not on its own Slot
grid, so it was refused before the constraint ever saw it. Both were plan
mistakes, not implementation ones.

---

## File structure

### New — pure, no database

| File | Responsibility |
|---|---|
| `lib/appointments/csv-input.ts` | Column contract, per-row validation, report and state types |
| `lib/appointments/csv-input.test.ts` | |

### New — database

| File | Responsibility |
|---|---|
| `lib/appointments/csv-upload.ts` | Loop the rows, create each through `createAppointment`, build the report |
| `lib/appointments/csv-upload.test.ts` | |

### New — app

| File | Responsibility |
|---|---|
| `components/overview/csv-upload.tsx` | The provider, the Upload CSV button, and the Sheet |
| `components/overview/csv-rejections.tsx` | The persistent report panel |

### Modified

| File | Change |
|---|---|
| `lib/time/zone.ts` | Add `tryParseWallClock` |
| `lib/time/zone.test.ts` | Cover it |
| `app/(app)/actions.ts` | Add `uploadCsvAction` |
| `components/overview/appointments-table.tsx` | Add a `toolbar` slot to the heading row |
| `app/(app)/page.tsx` | Wrap in the provider, render the panel, fill the toolbar |
| `package.json` | `papaparse`, `@types/papaparse` |

### Deleted

None. No migration, no schema change.

---

## Task 1: Parse a wall-clock date and time

**Files:**
- Modify: `lib/time/zone.ts` (add beside `tryParseWallTime`, around line 211)
- Test: `lib/time/zone.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `lib/time/zone.test.ts`:

```ts
describe("tryParseWallClock", () => {
  it("reads a space-separated date and time", () => {
    expect(tryParseWallClock("2026-08-21 09:30")).toEqual({
      year: 2026,
      month: 8,
      day: 21,
      hour: 9,
      minute: 30,
    })
  })

  it("reads the same value with a T separator", () => {
    // What a spreadsheet exports when it decides the column is a date.
    expect(tryParseWallClock("2026-08-21T09:30")).toEqual({
      year: 2026,
      month: 8,
      day: 21,
      hour: 9,
      minute: 30,
    })
  })

  it("refuses a time that is not strict HH:mm", () => {
    // Delegated to tryParseWallTime, so the rule lives in one place.
    expect(tryParseWallClock("2026-08-21 09:7")).toBeNull()
    expect(tryParseWallClock("2026-08-21 25:00")).toBeNull()
  })

  it("refuses an impossible date", () => {
    expect(tryParseWallClock("2026-13-21 09:30")).toBeNull()
    expect(tryParseWallClock("2026-02-30 09:30")).toBeNull()
  })

  it("refuses an unpadded or partial date", () => {
    expect(tryParseWallClock("2026-8-21 09:30")).toBeNull()
    expect(tryParseWallClock("21/08/2026 09:30")).toBeNull()
    expect(tryParseWallClock("2026-08-21")).toBeNull()
    expect(tryParseWallClock("")).toBeNull()
  })

  it("refuses a trailing offset rather than silently ignoring it", () => {
    // Accepting this would read +05:30 as if it were local, which is the one
    // failure mode a wall-clock format exists to avoid.
    expect(tryParseWallClock("2026-08-21T09:30:00+05:30")).toBeNull()
  })
})
```

Add `tryParseWallClock` to the file's existing import from `@/lib/time/zone`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- lib/time/zone.test.ts`
Expected: FAIL — `tryParseWallClock is not a function`.

- [ ] **Step 3: Write the implementation**

In `lib/time/zone.ts`, directly after `parseWallTime`:

```ts
/**
 * Parses `"2026-08-21 09:30"` into its wall-clock parts, or `null` if it is not
 * one.
 *
 * What a person writes in a spreadsheet. There is no offset in the string and
 * none is accepted: the zone comes from `businesses.timezone`, and the caller
 * runs `zonedTimeToInstant` to get an instant out of it. A string carrying its
 * own offset is refused rather than ignored — reading `+05:30` as if it were
 * local would book the wrong hour silently, which is exactly the failure this
 * format exists to avoid.
 *
 * `T` is accepted alongside a space because a spreadsheet that decides the
 * column is a date will export one.
 *
 * The time half is handed to `tryParseWallTime`, so strict `HH:mm` is written
 * down once. The date half is validated by reading it back: `Date.UTC` rolls
 * 2026-02-30 forward to 2 March rather than refusing it, so the only way to know
 * the date was real is to check the parts survived the round trip.
 */
export function tryParseWallClock(value: string): WallClock | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2})$/.exec(value.trim());
  if (!match) return null;

  const time = tryParseWallTime(match[4]);
  if (!time) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() + 1 !== month ||
    roundTrip.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day, hour: time.hour, minute: time.minute };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- lib/time/zone.test.ts`
Expected: PASS — the existing suite plus 6 new tests.

- [ ] **Step 5: Commit**

```bash
git add lib/time/zone.ts lib/time/zone.test.ts && git commit -m "Read a wall-clock date and time, with no offset allowed to sneak in"
```

---

## Task 2: The column contract

**Files:**
- Create: `lib/appointments/csv-input.ts`
- Test: `lib/appointments/csv-input.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { checkColumns } from "@/lib/appointments/csv-input";

describe("checkColumns", () => {
  it("accepts the four columns in any order and any case", () => {
    const result = checkColumns(["Time", "NAME", " phone ", "Service"]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The map holds the header as written, so the caller can read the row by it.
    expect(result.map).toEqual({
      name: "NAME",
      phone: " phone ",
      service: "Service",
      time: "Time",
    });
  });

  it("ignores columns it does not know", () => {
    const result = checkColumns(["name", "phone", "service", "time", "notes"]);
    expect(result.ok).toBe(true);
  });

  it("names the columns that are missing", () => {
    const result = checkColumns(["forename", "mobile"]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(
      'That file needs columns named name, phone, service and time. Found: forename, mobile.',
    );
  });

  it("refuses two columns that mean the same thing", () => {
    const result = checkColumns(["name", "Name", "phone", "service", "time"]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(
      'That file has two columns called "name". Keep one.',
    );
  });

  it("refuses a file with no header at all", () => {
    const result = checkColumns([]);
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- lib/appointments/csv-input.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/appointments/csv-input"`.

- [ ] **Step 3: Write the implementation**

Create `lib/appointments/csv-input.ts` with the module header, the constants, the report
and state types, and `checkColumns`. `parseCsvRow` arrives in Task 3.

```ts
/**
 * What a CSV upload accepts, and what it reports back (issue #8).
 *
 * Shaped like `lib/appointments/quick-add-input.ts` and for the same reasons: a
 * hand-written parser returning a discriminated result, with the state types
 * beside it because a `"use server"` module may export nothing but async
 * functions.
 *
 * Nothing here touches the database. The Services and the timezone are passed
 * in, so the whole of per-row validation is testable without one — and so the
 * caller loads them once for the whole file rather than once per row.
 */

/** The four columns a file must carry. Extra columns are ignored. */
export const CSV_COLUMNS = ["name", "phone", "service", "time"] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];

/**
 * Rows accepted in one upload.
 *
 * A bound on cost, not on correctness. Every row runs `createAppointment`
 * unchanged, which reloads the Business's schedule each time — about five
 * queries a row. Hoisting that out of the loop would be faster and would mean
 * the CSV path no longer runs the identical code quick-add runs, which is the
 * one property this feature is not willing to trade.
 */
export const MAX_CSV_ROWS = 200;

/** One data row, carrying the line number of the file it came from. */
export type CsvRow = {
  /** The line the person sees in their spreadsheet. Header is line 1. */
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
  rejected: CsvRowRejection[];
  /** Fully blank lines. Counted, never reported — a trailing newline is not an
   *  error, and an interior blank still has to hold its row number. */
  skipped: number;
};

/**
 * `file_error` is for problems with no row to hang them on — an empty file, a
 * missing column. It renders in the upload sheet. Everything per-row renders in
 * the persistent panel on the page (SPEC.md §11.4).
 */
export type CsvUploadState =
  | { status: "idle" }
  | { status: "file_error"; message: string }
  | { status: "done"; report: CsvUploadReport };

export const INITIAL_CSV_UPLOAD_STATE: CsvUploadState = { status: "idle" };

/** Canonical column name → the header as it was actually written in the file. */
export type ColumnMap = Record<CsvColumn, string>;

export type CheckedColumns =
  | { ok: true; map: ColumnMap }
  | { ok: false; message: string };

/**
 * Whether a header row carries the four columns, matched by name rather than by
 * position.
 *
 * Case and surrounding spaces are ignored, because a spreadsheet adds both. The
 * map hands back the header **as written**, so the caller reads each row by the
 * key PapaParse actually produced.
 *
 * Two headers that normalise to the same name are refused rather than resolved.
 * Picking one would silently drop a column the person filled in.
 */
export function checkColumns(headers: string[]): CheckedColumns {
  const map: Partial<ColumnMap> = {};

  for (const header of headers) {
    const normalised = header.trim().toLowerCase();
    const column = CSV_COLUMNS.find((c) => c === normalised);
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- lib/appointments/csv-input.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/appointments/csv-input.ts lib/appointments/csv-input.test.ts && git commit -m "Match CSV columns by name, and refuse two that mean the same thing"
```

---

## Task 3: Validate one row

**Files:**
- Modify: `lib/appointments/csv-input.ts`
- Test: `lib/appointments/csv-input.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `lib/appointments/csv-input.test.ts`:

```ts
import { parseCsvRow } from "@/lib/appointments/csv-input";

const SERVICES = [
  { id: "svc-haircut", name: "Haircut", durationMinutes: 45 },
  { id: "svc-colour", name: "Colour", durationMinutes: 90 },
];

const CONTEXT = { services: SERVICES, timezone: "Asia/Kolkata" };

function row(overrides: Partial<CsvRow> = {}): CsvRow {
  return {
    rowNumber: 2,
    name: "Priya Raman",
    phone: "+1 202 555 0110",
    service: "Haircut",
    time: "2026-08-21 09:30",
    ...overrides,
  };
}

describe("parseCsvRow", () => {
  it("normalises a good row", () => {
    const result = parseCsvRow(row(), CONTEXT);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value.name).toBe("Priya Raman");
    expect(result.value.phoneE164).toBe("+12025550110");
    expect(result.value.serviceId).toBe("svc-haircut");
    // 09:30 Asia/Kolkata is +05:30, so 04:00 UTC. Not a whole-hour zone, which
    // is the case a naive conversion gets wrong.
    expect(result.value.startsAt.toISOString()).toBe("2026-08-21T04:00:00.000Z");
  });

  it("matches a Service by name, trimmed and case-insensitively", () => {
    const result = parseCsvRow(row({ service: "  colour " }), CONTEXT);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value.serviceId).toBe("svc-colour");
  });

  it("reports every problem with a row at once", () => {
    const result = parseCsvRow(
      row({ name: "", phone: "9820012345", service: "Colur", time: "tuesday" }),
      CONTEXT,
    );

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.reasons).toEqual([
      "Enter the person's name.",
      "Start with the country code, like +44 or +91.",
      'No service called "Colur". Known services: Haircut, Colour.',
      "Write the time as 2026-08-21 09:30.",
    ]);
  });

  it("reuses the phone validator's own wording", () => {
    // The same sentence the quick-add card shows. One validator, one message.
    const result = parseCsvRow(row({ phone: "+44 (0) 20 7946 0018" }), CONTEXT);

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.reasons[0]).toContain("Drop the 0 in brackets");
  });

  it("refuses an ambiguous Service name rather than picking one", () => {
    const result = parseCsvRow(row({ service: "Haircut" }), {
      timezone: "Asia/Kolkata",
      services: [
        { id: "svc-a", name: "Haircut", durationMinutes: 45 },
        { id: "svc-b", name: "haircut", durationMinutes: 60 },
      ],
    });

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.reasons).toEqual([
      'Two services are called "Haircut". Rename one in Settings.',
    ]);
  });

  it("refuses a name over the ceiling quick-add uses", () => {
    const result = parseCsvRow(row({ name: "a".repeat(81) }), CONTEXT);

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.reasons).toEqual(["Keep the name under 80 characters."]);
  });

  it("reports a fully blank line as blank, not as four errors", () => {
    const result = parseCsvRow(
      { rowNumber: 6, name: "", phone: " ", service: "", time: "" },
      CONTEXT,
    );

    expect(result.status).toBe("blank");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- lib/appointments/csv-input.test.ts`
Expected: FAIL — `parseCsvRow is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `lib/appointments/csv-input.ts`. Imports at the top of the file:

```ts
import { parseE164 } from "@/lib/appointments/phone";
import { MAX_NAME_LENGTH } from "@/lib/appointments/quick-add-input";
import type { ServiceOption } from "@/lib/business/list-services";
import { tryParseWallClock, zonedTimeToInstant } from "@/lib/time/zone";
```

```ts
export type CsvRowContext = {
  services: ServiceOption[];
  /** IANA zone from `businesses.timezone`. The file carries no offset. */
  timezone: string;
};

export type ParsedCsvRow =
  | { status: "ok"; value: { name: string; phoneE164: string; serviceId: string; startsAt: Date } }
  | { status: "rejected"; reasons: string[] }
  | { status: "blank" };

/**
 * One CSV row, validated against the Business's own Services and timezone.
 *
 * **Every problem is reported, not just the first.** A row with a bad phone
 * number and an unknown service comes back with both. Stopping at the first
 * would make one upload take two passes to fix, and a per-row report exists
 * precisely so it takes one.
 *
 * The phone validator's wording is reused verbatim, so a bad number reads the
 * same here as it does in the quick-add card — `lib/appointments/phone.ts`
 * promised this feature exactly that.
 *
 * `serviceId` is never read from the file. The CSV carries a Service *name*,
 * resolved against this Business's Services, so there is no id to forge.
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
    A line with nothing on it. Reported as blank rather than as four errors,
    because the file is parsed with `skipEmptyLines: false` — an interior blank
    line has to keep its row number so every row after it still matches the
    spreadsheet.
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
      (s) => s.name.trim().toLowerCase() === service.toLowerCase(),
    );
    if (matches.length === 1) {
      serviceId = matches[0].id;
    } else if (matches.length > 1) {
      // Nothing stops a Business having two Services with the same name —
      // `lib/settings/services-input.ts` enforces no uniqueness. Picking one
      // would book an unknown duration, so this asks rather than guesses.
      reasons.push(
        `Two services are called "${service}". Rename one in Settings.`,
      );
    } else {
      const known = services.map((s) => s.name).join(", ");
      reasons.push(`No service called "${service}". Known services: ${known}.`);
    }
  }

  let startsAt = new Date(Number.NaN);
  if (time.length === 0) {
    reasons.push("Enter a time.");
  } else {
    const wall = tryParseWallClock(time);
    if (!wall) {
      reasons.push("Write the time as 2026-08-21 09:30.");
    } else {
      // The file carries no offset, so the zone comes from the Business. See
      // ADR-0007 for how a DST gap or an ambiguous hour resolves.
      startsAt = zonedTimeToInstant(wall, timezone);
    }
  }

  if (reasons.length > 0) return { status: "rejected", reasons };

  return { status: "ok", value: { name, phoneE164, serviceId, startsAt } };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- lib/appointments/csv-input.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/appointments/csv-input.ts lib/appointments/csv-input.test.ts && git commit -m "Say everything wrong with a CSV row, in the words quick-add already uses"
```

---

## Task 4: Run the file

**Files:**
- Create: `lib/appointments/csv-upload.ts`
- Test: `lib/appointments/csv-upload.test.ts`

This is the task that carries the acceptance criteria. Read
`docs/superpowers/specs/2026-08-19-csv-upload-design.md` Part 2 before writing it.

- [ ] **Step 1: Write the failing test**

```ts
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CsvRow } from "@/lib/appointments/csv-input";
import { uploadCsvRows } from "@/lib/appointments/csv-upload";
import { provisionUser } from "@/lib/auth/provision-user";
import { db, schema } from "@/lib/db";

const CLERK_ID = "user_test_csv_upload";
const TIMEZONE = "Asia/Kolkata";

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

/** Monday 17 August 2026 is the first open day after NOW. */
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
    const report = await upload([
      row(2, "09:00"),
      row(3, "10:00"),
      row(4, "11:00"),
    ]);

    expect(report).toEqual({ created: 3, rejected: [], skipped: 0 });
    expect(await appointmentCount()).toBe(3);
  });

  it("creates the good rows and reports the bad ones by spreadsheet row number", async () => {
    const report = await upload([
      row(2, "09:00"),
      { ...row(3, "10:00"), phone: "9820012345" },
      // A blank line at row 4. It must not renumber row 5.
      { rowNumber: 4, name: "", phone: "", service: "", time: "" },
      { ...row(5, "10:00"), service: "Massage" },
      row(6, "11:00"),
    ]);

    expect(report.created).toBe(3);
    expect(report.skipped).toBe(1);
    expect(report.rejected.map((r) => r.rowNumber)).toEqual([3, 5]);
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
      refuses the insert — `appointments_no_overlap` — not because anything
      here looked first. A pre-check reintroduced in uploadCsvRows would change
      which row wins or stop the constraint being the thing that decides, and
      this fails either way.

      The wording is the second half of the test. "Someone already has that
      time" would be a lie: nobody else did, row 2 did, a moment ago.
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

  it("names the earlier row even when the two Slots only overlap", async () => {
    // A 60-minute Haircut at 09:00 runs to 10:00, so 09:00 and 09:00 are not
    // the only way to collide. Comparing start times alone would print the
    // wrong sentence here — but the constraint still refuses the row.
    await db
      .insert(schema.services)
      .values({ businessId, name: "Colour", durationMinutes: 120 });

    const report = await upload([
      row(2, "09:00"),
      { ...row(3, "10:00"), service: "Colour" },
      { ...row(4, "11:00") },
    ]);

    expect(report.created).toBe(2);
    expect(report.rejected[0].reasons).toEqual(["Row 3 already takes that time."]);
  });

  it("says someone already has the time when the holder is not in this file", async () => {
    await upload([row(2, "09:00")]);

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
    const rows = Array.from({ length: 201 }, (_, i) => row(i + 2, "09:00"));

    await expect(upload(rows)).rejects.toThrow(/200/);
    expect(await appointmentCount()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- lib/appointments/csv-upload.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/appointments/csv-upload"`.

- [ ] **Step 3: Write the implementation**

```ts
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
 * Run one uploaded file (issue #8).
 *
 * Every row goes through `createAppointment` — the same function the quick-add
 * card calls, unchanged and not copied. That is the point: one set of rules for
 * "can this Appointment exist", not one for the form and a looser one for bulk.
 *
 * **Rows are awaited one at a time, never `Promise.all`.** The report has to be
 * deterministic, and sequential inserts are what make the second row targeting a
 * Slot lose to the first cleanly rather than by chance.
 *
 * **Nothing here asks whether a Slot is free before inserting, and nothing
 * should be added that does** — not even for two rows in the same file, where it
 * looks like there is no race to lose. `appointments_no_overlap` is the only
 * judge (SPEC.md §3 rule 8). See `lib/availability/book.ts` and
 * `lib/appointments/create.ts`, which say the same thing at their own layers.
 *
 * `created` below is the one thing that looks like an exception and is not. It
 * records ranges **after** Postgres has accepted them, and it is read **after**
 * Postgres has refused one — purely to pick which sentence to print. Delete it
 * and the behaviour is identical; only the wording gets worse. That is the
 * property that stops it turning into a pre-check.
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
type CreatedRange = { rowNumber: number; startsAt: number; endsAt: number };

export async function uploadCsvRows({
  businessId,
  timezone,
  rows,
  now = new Date(),
}: UploadCsvRowsInput): Promise<CsvUploadReport> {
  /*
    Thrown, not returned. A file over the cap is refused by the browser and by
    the Server Action before it reaches here, so arriving with 201 rows means a
    caller ignored both — a programming error, not something to render.
  */
  if (rows.length > MAX_CSV_ROWS) {
    throw new Error(`At most ${MAX_CSV_ROWS} rows, got ${rows.length}`);
  }

  // Once for the file, not once per row. The Service list is the only thing
  // per-row validation needs from the database.
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
      Postgres has already refused. All that is left is which sentence to print.

      Ranges, not start times: a 60-minute Haircut at 09:00 and a 120-minute
      Colour at 10:00 overlap without sharing a start, and the constraint
      refuses the second. Comparing starts alone would name nobody and print
      the wrong sentence.

      The end time is derived the same way `bookSlot` derives it — start plus
      the Service duration, in absolute milliseconds. It is used for nothing but
      this comparison.
    */
    const start = parsed.value.startsAt.getTime();
    const duration =
      services.find((s) => s.id === parsed.value.serviceId)?.durationMinutes ?? 0;
    const end = start + duration * 60_000;

    // Two ranges overlap when each starts before the other ends. Half-open, so
    // a Slot ending at exactly 10:00 does not clash with one starting there —
    // the same rule `tstzrange` applies inside the constraint.
    const clash = created.find((c) => c.startsAt < end && c.endsAt > start);

    rejected.push(
      reject(row, [
        clash
          ? `Row ${clash.rowNumber} already takes that time.`
          : "Someone already has that time.",
      ]),
    );
  }

  return { created: created.length, rejected, skipped };
}

function reject(row: CsvRow, reasons: string[]): CsvRowRejection {
  // An em dash rather than an empty cell, so a row missing its name is still a
  // recognisable line in the report rather than a gap.
  return { rowNumber: row.rowNumber, name: row.name.trim() || "—", reasons };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- lib/appointments/csv-upload.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/appointments/csv-upload.ts lib/appointments/csv-upload.test.ts && git commit -m "Run a CSV row by row, letting Postgres keep deciding who gets the Slot"
```

---

## Task 5: Add PapaParse

**Files:**
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Install**

```bash
npm install papaparse && npm install --save-dev @types/papaparse
```

Named by SPEC.md §2 ("CSV parsing | PapaParse, client-side"), so this needs no ADR.

- [ ] **Step 2: Verify it type-checks**

```bash
npx next typegen && npm run typecheck
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json && git commit -m "Add PapaParse, the CSV parser SPEC.md §2 fixes"
```

---

## Task 6: The Server Action

**Files:**
- Modify: `app/(app)/actions.ts`

- [ ] **Step 1: Write the implementation**

Append to `app/(app)/actions.ts`:

```ts
/**
 * Create Appointments from an uploaded CSV (issue #8).
 *
 * The browser parses the file — SPEC.md §2 puts PapaParse client-side — and
 * sends the rows here. **None of the browser's checks are trusted.** A Server
 * Action is a POST reachable by anyone who can send it, so the shape and the row
 * cap are settled again, and every field is validated on this side. The client's
 * copies of those checks exist to save a round trip, nothing more.
 *
 * File-level problems come back as `file_error` and render in the upload sheet.
 * Per-row problems come back in the report and render in the persistent panel on
 * the page, because SPEC.md §11.4 wants inline persistent UI for anything
 * requiring action, and a rejected row is the definition of that.
 */
export async function uploadCsvAction(
  rows: unknown,
): Promise<CsvUploadState> {
  const { business } = await requireBusiness();

  if (!Array.isArray(rows) || rows.length === 0) {
    return { status: "file_error", message: "That file is empty." };
  }

  if (rows.length > MAX_CSV_ROWS) {
    return {
      status: "file_error",
      message: `That file has ${rows.length} rows. Upload at most ${MAX_CSV_ROWS} at a time.`,
    };
  }

  // Coerced rather than assumed. Anything not a string becomes an empty one,
  // which the row validator already has a message for.
  const clean: CsvRow[] = rows.map((row, index) => {
    const r = (row ?? {}) as Partial<Record<keyof CsvRow, unknown>>;
    const rowNumber =
      typeof r.rowNumber === "number" && Number.isInteger(r.rowNumber) && r.rowNumber > 0
        ? r.rowNumber
        : index + 2;
    return {
      rowNumber,
      name: text(r.name),
      phone: text(r.phone),
      service: text(r.service),
      time: text(r.time),
    };
  });

  const report = await uploadCsvRows({
    businessId: business.id,
    timezone: business.timezone,
    rows: clean,
  });

  // Same one line as the quick-add write: the table and the stat strip come back
  // fresh in the same round trip, with nothing to poll.
  revalidatePath("/");

  return { status: "done", report };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
```

Add the imports at the top of the file.

- [ ] **Step 2: Verify it type-checks**

```bash
npx next typegen && npm run typecheck && npm run lint
```
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add "app/(app)/actions.ts" && git commit -m "Accept an uploaded CSV, trusting nothing the browser said about it"
```

---

## Task 7: The upload sheet

**Files:**
- Create: `components/overview/csv-upload.tsx`

- [ ] **Step 1: Write the implementation**

A `"use client"` module with three exports.

**`CsvUploadProvider`** — a context holding `CsvUploadState` plus a setter, rendering
`{children}`. Server Components pass straight through it; React context reaches the client
components nested inside them because context follows tree position, not module boundaries.

**`useCsvUploadReport()`** — the hook `CsvRejections` reads. Throws outside the provider,
so a missing wrapper fails loudly at development time rather than silently rendering
nothing.

**`UploadCsvButton({ timezone })`** — the button and the `Sheet`.

```tsx
const [file, setFile] = React.useState<File | null>(null)
const [fileError, setFileError] = React.useState<string | null>(null)
const [open, setOpen] = React.useState(false)
const [uploading, startUploading] = React.useTransition()
```

`useTransition` and a direct call, matching `slotOptionsAction`'s use in
`quick-call-card.tsx` — not `useActionState`, because the file has to be read and parsed
before there is anything to submit.

Submit handler:

```tsx
const text = await file.text()
if (text.trim().length === 0) return setFileError("That file is empty.")

const parsed = Papa.parse<Record<string, string>>(text, {
  header: true,
  skipEmptyLines: false,   // an interior blank line must keep its row number
})

if (parsed.errors.some((e) => e.code === "UndetectableDelimiter" || e.code === "MissingQuotes")) {
  return setFileError("That file could not be read as CSV. Check for an unclosed quote.")
}

const columns = checkColumns(parsed.meta.fields ?? [])
if (!columns.ok) return setFileError(columns.message)

// A trailing newline is not a row. An interior blank line is, and keeps its
// number so every row after it still matches the spreadsheet.
const data = dropTrailingBlanks(parsed.data)
if (data.length === 0) {
  return setFileError("That file has a header row and nothing under it.")
}
if (data.length > MAX_CSV_ROWS) {
  return setFileError(
    `That file has ${data.length} rows. Upload at most ${MAX_CSV_ROWS} at a time.`,
  )
}

const rows: CsvRow[] = data.map((raw, index) => ({
  rowNumber: index + 2,               // the header is line 1
  name: raw[columns.map.name] ?? "",
  phone: raw[columns.map.phone] ?? "",
  service: raw[columns.map.service] ?? "",
  time: raw[columns.map.time] ?? "",
}))

startUploading(async () => {
  const result = await uploadCsvAction(rows)
  if (result.status === "file_error") return setFileError(result.message)
  setReport(result)      // to the provider
  setOpen(false)         // the report is the page's now, not the sheet's
  setFile(null)
})
```

Sheet contents, in order:

1. `SheetTitle` "Upload CSV", `SheetDescription` "One row per person. Times are read in
   {timezone}."
2. The column contract, rendered as a `font-mono` block at `text-table`:
   ```
   name,phone,service,time
   Priya Raman,+1 202 555 0110,Cleaning,2026-08-21 09:30
   ```
3. `<input type="file" accept=".csv,text/csv">`, styled to match `components/ui/input.tsx`
   the way `quick-call-card.tsx`'s `SELECT_CLASS` does — no focus ring of its own, because
   `app/globals.css` already gives every focusable element the accent outline.
4. `FieldError` for `fileError`, from `components/ui/field-error.tsx`.
5. A submit `Button`, disabled without a file, carrying its own `Loader2` spinner while
   `uploading`. §11.4 rules out a full-page blocker.

`side="right"`, widened with `data-[side=right]:sm:max-w-lg` — the built-in variant has to
be beaten by a `data-` selector, per the note at `components/app-shell/mobile-nav.tsx:34`.

No `window.confirm` and no native dialog, holding the line
`components/settings/services-section.tsx:47` already holds.

- [ ] **Step 2: Verify it type-checks**

```bash
npx next typegen && npm run typecheck && npm run lint
```
Expected: clean.

- [ ] **Step 3: Hold the commit.** It ships with Task 9, which is what renders it.

---

## Task 8: The report panel

**Files:**
- Create: `components/overview/csv-rejections.tsx`

- [ ] **Step 1: Write the implementation**

`"use client"`. Reads `useCsvUploadReport()`; renders `null` unless the state is `done`.

**No rejections** — a `rounded-card border border-line bg-surface` panel, a `confirmed`
dot, "Created 8 appointments.", and a Dismiss button.

**Some rejections** — `border-attention`, an `h2` at `text-section` reading "3 rows
rejected", a `text-body text-text-muted` line reading "Created 8 appointments. Fix these
rows and upload again.", then a `<ul>` with one `<li>` per row:

```
Row 4 · Grace Mwangi            ← rowNumber in font-mono, name in text
  Start with the country code, like +44 or +91.
  No service called "Colur". Known services: Haircut, Colour, Blow-dry.
```

Reasons are a nested `<ul>`, so a row with two problems reads as two problems.

Amber and not red, deliberately: §11.2's `attention` means a human has to act, and
`components/overview/status-pill.tsx` already reserves red for the person saying no. Write
that reasoning into the file — the next screen that needs a "you must fix this" surface
will otherwise re-derive it differently.

Dismiss sets the provider state back to `idle`. Stacks at 375px: the row number and the
name go on one line, the reasons wrap beneath.

The panel is a `<section aria-labelledby=…>`, not `role="status"` — it is persistent, and
an alert role would make a screen reader re-announce it on every unrelated re-render.

- [ ] **Step 2: Verify it type-checks**

```bash
npx next typegen && npm run typecheck && npm run lint
```
Expected: clean.

- [ ] **Step 3: Hold the commit.** Ships with Task 9.

---

## Task 9: Put it on the page

**Files:**
- Modify: `components/overview/appointments-table.tsx` (the heading block, around line 30)
- Modify: `app/(app)/page.tsx`

- [ ] **Step 1: Add the toolbar slot**

`AppointmentsTable` gains `toolbar?: React.ReactNode`. Its heading block becomes:

```tsx
<div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
  <div className="flex flex-col gap-1">
    <h2 …>Appointments</h2>
    <p …>Times shown in {timezone}.</p>
  </div>
  {toolbar}
</div>
```

A slot rather than the button itself, because the table is a Server Component and the
button is a client one. Passing a node in keeps the table from having to know that.

Update the file's header comment: Upload CSV is no longer "not here".

- [ ] **Step 2: Wire the page**

```tsx
<CsvUploadProvider>
  <div className="flex flex-col gap-8">
    <StatStrip stats={stats} />
    <CsvRejections />
    <QuickCallCard … />
    <AppointmentsTable
      appointments={appointments}
      timezone={business.timezone}
      toolbar={<UploadCsvButton timezone={business.timezone} />}
    />
  </div>
</CsvUploadProvider>
```

The panel sits above the Quick call card so it is the first thing on screen after an
upload. Update the page's header comment: #8 is no longer absent.

- [ ] **Step 3: Verify it type-checks**

```bash
npx next typegen && npm run typecheck && npm run lint
```
Expected: clean.

- [ ] **Step 4: Commit Tasks 7, 8 and 9 together**

```bash
git add components/overview/csv-upload.tsx components/overview/csv-rejections.tsx components/overview/appointments-table.tsx "app/(app)/page.tsx" && git commit -m "Upload a CSV from Overview, and keep the rejected rows on screen"
```

---

## Task 10: Check it in the browser

**Files:** none.

Run `npm run dev` and sign in. Build the test CSVs by hand — the valid times have to be
real open Slots, which depend on the day the account was created, so read them off the
Quick call card's time picker first.

| # | Check | Acceptance criterion |
|---|---|---|
| 1 | Upload four valid rows → four rows in the table, stat strip up by four, panel reads "Created 4 appointments." | A valid CSV creates every row and reports the count |
| 2 | Upload a mixed file — a bad phone, an unknown service, a Sunday time, one good row → the good rows land, each bad one is listed by row number with its own reason | A mixed CSV creates the valid rows and lists each rejected row |
| 3 | Put a blank line in the middle of the file → the row numbers in the panel still match the line numbers in the spreadsheet | (numbering rule from the design doc) |
| 4 | Two rows on the same time → exactly one appears in the table; the other reads "Row N already takes that time." | Two CSV rows targeting the same Slot cannot both be created |
| 5 | Leave the panel alone and add an Appointment from the Quick call card → the panel survives the revalidate. Press Dismiss → it clears with no page reload | Rejection output persists on screen until dismissed |
| 6 | Upload an empty file, a header-only file, and one with `forename,mobile` → three different designed messages in the sheet, and nothing in the browser console | A malformed or empty file fails with a designed message rather than an exception |
| 7 | At 375px the panel stacks and stays readable; the table falls back to cards | SPEC.md §11.4 |
| 8 | Tab through the sheet — every control shows the accent focus ring at 2px offset; Escape closes it; focus returns to the Upload CSV button | SPEC.md §11.4 |

- [ ] **Step 1: Walk every row of the table above**
- [ ] **Step 2: Close the issue**

```bash
gh issue close 8 --comment "Shipped. Design: docs/superpowers/specs/2026-08-19-csv-upload-design.md"
```

---

## Notes for whoever executes this

- **Run `npx next typegen` before the first `npm run typecheck`.** Next 16 generates route
  types, and a fresh checkout has none.
- **Run tests one file at a time.** `vitest.config.mts` sets `fileParallelism: false`, and
  every database test shares one embedded Postgres.
- **Every test file cleans up children first** — calls → appointments → services →
  business_hours → businesses → users. Every foreign key is `ON DELETE NO ACTION`.
- **Do not add an overlap query anywhere in `uploadCsvRows`.** Not to make the report
  nicer, not because two rows in one file "cannot really race". The `created` list exists
  only to word a refusal Postgres has already issued; if you find yourself reading it
  before an insert, stop and re-read Part 2 of the design doc.
- **Do not hoist `loadSchedule` out of the per-row loop.** It would be faster and it would
  mean the CSV path stops running the identical code quick-add runs. `MAX_CSV_ROWS` is the
  bound that makes the untuned version fine.
- **Do not add a second phone or time validator.** `parseE164` and `tryParseWallClock` are
  the only ones, wording included.
