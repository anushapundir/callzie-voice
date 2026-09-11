# Schedule — read-only day view Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `/schedule` — one day of Business Hours drawn as a vertical column of time, with Appointments placed in it by start and duration, Collisions marked, and no interaction beyond three links that change the day.

**Architecture:** A pure layout core (`lib/schedule/day-layout.ts`) turns Business Hours, a timezone, a date and a list of Appointments into finished positions. It has no database and no clock, so every daylight-saving case is unit-testable. A thin loader (`lib/schedule/load-day.ts`) does two queries and feeds it. The page and components only render. This mirrors the pair the repo already has: `lib/availability/slots.ts` (pure) and `lib/availability/find.ts` (loader).

**Tech Stack:** Next.js 16.3 App Router (Server Components, typed routes), React 19, Drizzle ORM on Postgres, Tailwind 4 (CSS-first tokens in `app/globals.css`), Vitest 4 against a real embedded Postgres.

**Spec:** `docs/superpowers/specs/2026-08-19-schedule-read-only-day-view-design.md`
**Issue:** [#18](https://github.com/anushapundir/callzie/issues/18)

---

## Things to read before starting

Read these four files. They are short and they carry the conventions this plan follows.

| File | Why |
|---|---|
| `lib/time/zone.ts` | Every wall-clock ↔ instant conversion here goes through it. Read the header comment on `zonedTimeToInstant` — the DST rules matter |
| `lib/availability/slots.ts` | The pure-core pattern being copied, and the "step in real milliseconds, not clock time" rule |
| `lib/db/schema.ts` lines 55-72 | `SLOT_HOLDING_STATUSES`, and why it must never be re-listed by hand |
| `app/(app)/settings/page.tsx` | The `PageProps<...>` / `await searchParams` / `readParam` pattern |

**Two style facts about this repo**, both real and both silent if you get them wrong:

1. Files under `lib/` end statements with semicolons. Files under `app/` and `components/` do not. Match the directory you are in.
2. `app/globals.css` deletes Tailwind's stock palette, type scale and radius scale. `bg-blue-500`, `text-lg` and `rounded-xl` **do not exist** and compile to nothing. Only the tokens declared in that file work.

**Running things:**

- Tests: `npm test` (whole suite) or `npx vitest run <path>` (one file). The first run starts an embedded Postgres, so give it a minute.
- Types: `npm run typecheck`
- Lint: `npm run lint`
- App: `npm run dev`

---

## File Structure

**Create:**

| File | Responsible for |
|---|---|
| `lib/schedule/day-param.ts` | How a day is spelled — parsing `?date`, building a link, writing the heading |
| `lib/schedule/day-param.test.ts` | Its tests. Pure, no database |
| `lib/schedule/day-layout.ts` | The pure core: window, gridlines, block positions, shaded bands |
| `lib/schedule/day-layout.test.ts` | Its tests. Pure, no database. Carries the DST cases |
| `lib/schedule/load-day.ts` | Two queries, then hand off to the core |
| `lib/schedule/load-day.test.ts` | Its tests. Database-backed |
| `lib/appointments/status-style.ts` | Which colour and label each Appointment status gets |
| `components/schedule/day-nav.tsx` | Prev / Today / Next, and the day heading |
| `components/schedule/day-grid.tsx` | The track, the hour gutter, the shaded bands |
| `components/schedule/appointment-block.tsx` | One Appointment as a positioned block |
| `components/schedule/closed-day.tsx` | The card a shut, empty day renders instead of a grid |

**Modify:**

| File | Change |
|---|---|
| `lib/time/zone.ts` | Add `clockInZone` — an instant as `"09:00"` in a zone. Three callers need it |
| `components/overview/status-pill.tsx` | Read `STATUS_STYLES` from its new home instead of declaring it |
| `app/(app)/schedule/page.tsx` | Replace the `Placeholder` with the real screen |

---

## Task 1: `clockInZone` — an instant as a wall clock

The gridline labels, the day heading's "Open 09:00 – 17:00" and every block's time range all need the same thing: an instant written as `"09:00"` in the Business's timezone. `formatInZone` already exists but includes the weekday and date, which is wrong for all three.

**Files:**
- Modify: `lib/time/zone.ts` (append at the end)
- Test: `lib/time/zone.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `lib/time/zone.test.ts`:

```ts
describe("clockInZone", () => {
  it("writes an instant as a zero-padded wall clock", () => {
    // 03:30 UTC is 09:00 in Kolkata (+05:30).
    expect(clockInZone(new Date("2026-08-19T03:30:00.000Z"), "Asia/Kolkata")).toBe(
      "09:00",
    );
  });

  it("uses a 24-hour clock, so midnight is 00:00 and not 24:00", () => {
    expect(
      clockInZone(new Date("2026-08-18T18:30:00.000Z"), "Asia/Kolkata"),
    ).toBe("00:00");
  });

  it("does not round a half-hour zone to the hour", () => {
    // 04:00 UTC is 09:30 in Kolkata, not 09:00 or 10:00.
    expect(clockInZone(new Date("2026-08-19T04:00:00.000Z"), "Asia/Kolkata")).toBe(
      "09:30",
    );
  });
});
```

Add `clockInZone` to that file's existing import from `@/lib/time/zone`.

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run lib/time/zone.test.ts`
Expected: FAIL — `clockInZone is not a function`, or a TypeScript error saying it is not exported.

- [ ] **Step 3: Implement it**

Append to `lib/time/zone.ts`:

```ts
/**
 * An instant as the wall clock reads it in `timeZone` — `"09:00"`.
 *
 * Distinct from `formatInZone`, which includes the weekday and date. Three
 * callers want only the time: the Schedule grid's hour labels, its day heading
 * ("Open 09:00 - 17:00") and each Appointment block's range.
 *
 * Built from `partsInZone` rather than a fourth `Intl` formatter, so the
 * `hourCycle: "h23"` decision that file makes — midnight is `00`, never `24` —
 * holds here for free.
 */
export function clockInZone(instant: Date, timeZone: string): string {
  const { hour, minute } = partsInZone(instant, timeZone);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run lib/time/zone.test.ts`
Expected: PASS, including every test that was already in the file.

- [ ] **Step 5: Commit**

```bash
git add lib/time/zone.ts lib/time/zone.test.ts
git commit -m "Add clockInZone, an instant as a bare wall clock"
```

---

## Task 2: `day-param.ts` — how a day is spelled

**Files:**
- Create: `lib/schedule/day-param.ts`
- Test: `lib/schedule/day-param.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/schedule/day-param.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  formatDayHeading,
  formatDayParam,
  parseDayParam,
  resolveDay,
  scheduleHref,
} from "@/lib/schedule/day-param";

const KOLKATA = "Asia/Kolkata";

describe("parseDayParam", () => {
  it("reads a well-formed date", () => {
    expect(parseDayParam("2026-08-19")).toEqual({
      year: 2026,
      month: 8,
      day: 19,
    });
  });

  it("rejects a date that does not exist", () => {
    // Date.UTC(2026, 1, 30) silently rolls to 2 March, so this can only be
    // caught by reading the parse back.
    expect(parseDayParam("2026-02-30")).toBeNull();
  });

  it("accepts 29 February in a leap year", () => {
    expect(parseDayParam("2028-02-29")).toEqual({
      year: 2028,
      month: 2,
      day: 29,
    });
  });

  it("rejects anything that is not YYYY-MM-DD", () => {
    expect(parseDayParam("banana")).toBeNull();
    expect(parseDayParam("2026-8-19")).toBeNull();
    expect(parseDayParam("19-08-2026")).toBeNull();
    expect(parseDayParam("2026-08-19T10:00:00Z")).toBeNull();
    expect(parseDayParam("")).toBeNull();
    expect(parseDayParam(null)).toBeNull();
  });

  it("rejects a two-digit year, which Date.UTC would read as the 1900s", () => {
    expect(parseDayParam("0050-01-01")).toBeNull();
  });
});

describe("formatDayParam", () => {
  it("zero-pads the month and day", () => {
    expect(formatDayParam({ year: 2026, month: 1, day: 5 })).toBe("2026-01-05");
  });
});

describe("resolveDay", () => {
  it("uses the param when it is valid", () => {
    const now = new Date("2026-08-19T03:30:00.000Z");
    expect(resolveDay("2026-12-25", now, KOLKATA)).toEqual({
      year: 2026,
      month: 12,
      day: 25,
    });
  });

  it("falls back to today in the Business's zone, not the viewer's", () => {
    // 20:00 UTC on the 18th is already the 19th in Kolkata (+05:30).
    const now = new Date("2026-08-18T20:00:00.000Z");
    expect(resolveDay(null, now, KOLKATA)).toEqual({
      year: 2026,
      month: 8,
      day: 19,
    });
  });

  it("falls back to today rather than throwing on a bad param", () => {
    const now = new Date("2026-08-19T03:30:00.000Z");
    expect(resolveDay("banana", now, KOLKATA)).toEqual({
      year: 2026,
      month: 8,
      day: 19,
    });
  });
});

describe("scheduleHref", () => {
  it("builds the link a day nav points at", () => {
    expect(scheduleHref({ year: 2026, month: 8, day: 19 })).toBe(
      "/schedule?date=2026-08-19",
    );
  });
});

describe("formatDayHeading", () => {
  it("writes the day the way the heading reads it", () => {
    // 19 August 2026 is a Wednesday.
    expect(formatDayHeading({ year: 2026, month: 8, day: 19 }, KOLKATA)).toBe(
      "Wed 19 Aug 2026",
    );
  });

  it("does not slip a day in a zone far from UTC", () => {
    expect(
      formatDayHeading({ year: 2026, month: 8, day: 19 }, "Pacific/Auckland"),
    ).toBe("Wed 19 Aug 2026");
    expect(
      formatDayHeading({ year: 2026, month: 8, day: 19 }, "Pacific/Honolulu"),
    ).toBe("Wed 19 Aug 2026");
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run lib/schedule/day-param.test.ts`
Expected: FAIL — cannot resolve `@/lib/schedule/day-param`.

- [ ] **Step 3: Implement it**

Create `lib/schedule/day-param.ts`:

```ts
import {
  addCalendarDays,
  todayInZone,
  zonedTimeToInstant,
  type CivilDate,
} from "@/lib/time/zone";

/**
 * How the Schedule screen spells a day — in the URL, in a link, and in the
 * heading.
 *
 * All of it is pure so it can be tested without rendering a page. The date the
 * screen shows is a product decision with two failure modes worth pinning, and
 * neither is reachable from a Server Component in a test: an impossible date in
 * the query string, and "today" meaning the viewer's day rather than the
 * Business's.
 */

/** The query key the day travels in: `/schedule?date=2026-08-19`. */
export const SCHEDULE_DATE_PARAM = "date";

/** A civil date as `2026-08-19`. */
export function formatDayParam(date: CivilDate): string {
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");
  return `${date.year}-${month}-${day}`;
}

/**
 * `"2026-08-19"` as a civil date, or `null` if it is not one.
 *
 * The format check alone is not enough. `2026-02-30` matches the pattern
 * perfectly, and `Date.UTC(2026, 1, 30)` accepts it and quietly rolls forward
 * to 2 March — so a naive parser would render "30 February" as 2 March and
 * never say a word.
 *
 * The fix is to normalise through the calendar and read the result back.
 * `addCalendarDays(date, 0)` does the roll-forward, and if what comes out does
 * not spell the same string, the date never existed. The same round trip
 * rejects `0050-01-01`, which `Date.UTC` would read as the year 1950.
 */
export function parseDayParam(value: string | null): CivilDate | null {
  if (!value) return null;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const normalised = addCalendarDays(
    { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) },
    0,
  );
  return formatDayParam(normalised) === value ? normalised : null;
}

/**
 * The day the screen should show.
 *
 * A bad `?date` is not an error page. Someone editing the URL by hand, or a
 * stale link, lands on today — which is what they would have got with no param
 * at all.
 *
 * `now` is injected rather than read here, so "today" is assertable at a
 * boundary. It matters: 20:00 UTC is already tomorrow in Kolkata, and this must
 * resolve against the Business's clock rather than the server's or the viewer's.
 */
export function resolveDay(
  value: string | null,
  now: Date,
  timezone: string,
): CivilDate {
  return parseDayParam(value) ?? todayInZone(now, timezone);
}

/** The link a day nav points at. */
export function scheduleHref(date: CivilDate): string {
  return `/schedule?${SCHEDULE_DATE_PARAM}=${formatDayParam(date)}`;
}

const HEADING_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

/**
 * The day as the heading writes it — `"Wed 19 Aug 2026"`.
 *
 * `en-GB` for day-before-month, matching `formatInZone` in `lib/time/zone.ts`.
 * Two people looking at the same day must read the same heading, so the format
 * is fixed rather than following the viewer's locale.
 *
 * The instant handed to the formatter is **noon**, not midnight. A civil date
 * has no time of its own, and midnight is the one hour a DST transition can
 * push across a date boundary — a zone that springs forward at 00:00 would
 * render the heading as the following day. Noon is never within twelve hours of
 * a transition.
 */
export function formatDayHeading(date: CivilDate, timezone: string): string {
  let formatter = HEADING_FORMATTERS.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    });
    HEADING_FORMATTERS.set(timezone, formatter);
  }
  return formatter.format(
    zonedTimeToInstant({ ...date, hour: 12, minute: 0 }, timezone),
  );
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run lib/schedule/day-param.test.ts`
Expected: PASS, 13 tests.

If `formatDayHeading` fails on the exact string, log what it produced. Some ICU builds emit `"Wed, 19 Aug 2026"` with a comma. If that is what you see, fix the **assertion** to match the real output rather than post-processing the string — the comma is cosmetic and stripping it would be a hand-rolled format pretending to be `Intl`.

- [ ] **Step 5: Commit**

```bash
git add lib/schedule/day-param.ts lib/schedule/day-param.test.ts
git commit -m "Parse, build and write the Schedule day param"
```

---

## Task 3: `day-layout.ts` — the window and the gridlines

The core, in two tasks. This one builds the window the day is drawn in and the hour lines across it. Task 4 adds the blocks and the shaded bands.

**Files:**
- Create: `lib/schedule/day-layout.ts`
- Test: `lib/schedule/day-layout.test.ts`

- [ ] **Step 1: Write the failing test**

Create `lib/schedule/day-layout.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { dayLayout, type DayAppointment } from "@/lib/schedule/day-layout";

const KOLKATA = "Asia/Kolkata";
const NEW_YORK = "America/New_York";

/** 19 August 2026, a Wednesday. */
const WEDNESDAY = { year: 2026, month: 8, day: 19 };

/** Business Hours as the loader hands them over: wall clock, never instants. */
const NINE_TO_FIVE = { opensAt: "09:00", closesAt: "17:00" };

function appointment(
  overrides: Partial<DayAppointment> & Pick<DayAppointment, "startsAt" | "endsAt">,
): DayAppointment {
  return {
    id: "appt-1",
    name: "Priya Sharma",
    serviceName: "Cleaning",
    status: "confirmed",
    needsAttentionReason: null,
    ...overrides,
  };
}

describe("dayLayout — the window", () => {
  it("runs from opening to closing when every Appointment is inside", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: NINE_TO_FIVE,
      // 09:00-09:45 Kolkata.
      appointments: [
        appointment({
          startsAt: new Date("2026-08-19T03:30:00.000Z"),
          endsAt: new Date("2026-08-19T04:15:00.000Z"),
        }),
      ],
    });

    expect(layout).not.toBeNull();
    // 09:00 and 17:00 Kolkata (+05:30).
    expect(layout?.windowStart.toISOString()).toBe("2026-08-19T03:30:00.000Z");
    expect(layout?.windowEnd.toISOString()).toBe("2026-08-19T11:30:00.000Z");
    expect(layout?.windowMinutes).toBe(480);
  });

  it("stretches to hold an Appointment that starts before opening", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: NINE_TO_FIVE,
      // 08:00-08:45 Kolkata, an hour before the doors open.
      appointments: [
        appointment({
          startsAt: new Date("2026-08-19T02:30:00.000Z"),
          endsAt: new Date("2026-08-19T03:15:00.000Z"),
        }),
      ],
    });

    expect(layout?.windowStart.toISOString()).toBe("2026-08-19T02:30:00.000Z");
    expect(layout?.windowMinutes).toBe(540);
  });

  it("rounds outward to a whole hour on the Business's own clock", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: null,
      // 14:20-14:50 Kolkata. Rounds out to 14:00-15:00.
      appointments: [
        appointment({
          startsAt: new Date("2026-08-19T08:50:00.000Z"),
          endsAt: new Date("2026-08-19T09:20:00.000Z"),
        }),
      ],
    });

    // 14:00 Kolkata is 08:30 UTC — a half hour, because +05:30 is a half-hour
    // offset. Nothing here ever rounds a UTC instant.
    expect(layout?.windowStart.toISOString()).toBe("2026-08-19T08:30:00.000Z");
    expect(layout?.windowEnd.toISOString()).toBe("2026-08-19T09:30:00.000Z");
  });

  it("has no window at all on a closed day with nothing booked", () => {
    expect(
      dayLayout({
        date: WEDNESDAY,
        timezone: KOLKATA,
        hours: null,
        appointments: [],
      }),
    ).toBeNull();
  });

  it("builds the window from the Appointments alone on a closed day", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: null,
      // 14:00-14:45 Kolkata.
      appointments: [
        appointment({
          startsAt: new Date("2026-08-19T08:30:00.000Z"),
          endsAt: new Date("2026-08-19T09:15:00.000Z"),
        }),
      ],
    });

    expect(layout?.hours).toBeNull();
    expect(layout?.windowStart.toISOString()).toBe("2026-08-19T08:30:00.000Z");
    expect(layout?.windowEnd.toISOString()).toBe("2026-08-19T09:30:00.000Z");
  });
});

describe("dayLayout — the gridlines", () => {
  it("puts one line on every hour, evenly spaced", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: NINE_TO_FIVE,
      appointments: [],
    });

    expect(layout?.gridlines.map((line) => line.label)).toEqual([
      "09:00",
      "10:00",
      "11:00",
      "12:00",
      "13:00",
      "14:00",
      "15:00",
      "16:00",
      "17:00",
    ]);
    expect(layout?.gridlines[0]?.topPercent).toBe(0);
    expect(layout?.gridlines[4]?.topPercent).toBe(50);
    expect(layout?.gridlines[8]?.topPercent).toBe(100);
  });

  it("skips the hour a spring-forward day never has", () => {
    // 8 March 2026 in New York: 02:00 becomes 03:00.
    const layout = dayLayout({
      date: { year: 2026, month: 3, day: 8 },
      timezone: NEW_YORK,
      hours: { opensAt: "01:00", closesAt: "04:00" },
      appointments: [],
    });

    expect(layout?.gridlines.map((line) => line.label)).toEqual([
      "01:00",
      "03:00",
      "04:00",
    ]);
    // Three wall-clock hours, but only two real ones. The day is shorter.
    expect(layout?.windowMinutes).toBe(120);
  });

  it("draws the hour a fall-back day has twice, twice", () => {
    // 1 November 2026 in New York: 02:00 becomes 01:00.
    const layout = dayLayout({
      date: { year: 2026, month: 11, day: 1 },
      timezone: NEW_YORK,
      hours: { opensAt: "00:00", closesAt: "03:00" },
      appointments: [],
    });

    expect(layout?.gridlines.map((line) => line.label)).toEqual([
      "00:00",
      "01:00",
      "01:00",
      "02:00",
      "03:00",
    ]);
    // Three wall-clock hours, four real ones.
    expect(layout?.windowMinutes).toBe(240);
  });

  it("never starts the window after the earliest Appointment", () => {
    // The guarantee that rounding can only widen. On a spring-forward morning
    // a naive floor can land in the gap, where ADR-0007 resolves it *forward*.
    const startsAt = new Date("2026-03-08T06:30:00.000Z"); // 01:30 EST
    const layout = dayLayout({
      date: { year: 2026, month: 3, day: 8 },
      timezone: NEW_YORK,
      hours: null,
      appointments: [
        appointment({
          startsAt,
          endsAt: new Date("2026-03-08T07:15:00.000Z"), // 03:15 EDT
        }),
      ],
    });

    expect(layout!.windowStart.getTime()).toBeLessThanOrEqual(startsAt.getTime());
    expect(layout!.windowEnd.getTime()).toBeGreaterThanOrEqual(
      new Date("2026-03-08T07:15:00.000Z").getTime(),
    );
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run lib/schedule/day-layout.test.ts`
Expected: FAIL — cannot resolve `@/lib/schedule/day-layout`.

- [ ] **Step 3: Implement it**

Create `lib/schedule/day-layout.ts`. This is the whole file including the block and band types Task 4 fills in — declaring them now keeps the shape stable.

```ts
import type { AppointmentStatus, NeedsAttentionReason } from "@/lib/db/schema";
import {
  clockInZone,
  parseWallTime,
  partsInZone,
  zonedTimeToInstant,
  type CivilDate,
} from "@/lib/time/zone";

/**
 * One day of the Schedule screen, laid out — SPEC.md §11.3's read-only day view.
 *
 * The pure core, in the sense `lib/availability/slots.ts` is: no database, no
 * clock of its own, everything injected. That file explains why at length and
 * the reasoning is identical here — the daylight-saving cases *are* the
 * substance of this module, and they have to be assertable without seeding a
 * Business.
 *
 * **The two rules that make the awkward days come out right:**
 *
 * 1. **Rounding the window outward may only ever widen it.** Both ends round to
 *    a whole hour on the Business's clock so the gridlines read as round
 *    numbers. But on a spring-forward morning, flooring 02:30 to 02:00 names a
 *    wall clock that never happens, and ADR-0007 resolves a nonexistent time
 *    *forward* — to 03:00, which is later than where we started. Applied
 *    blindly, the window would begin after the Appointment it exists to
 *    contain. So every rounded value is compared against the original and the
 *    wider one wins.
 *
 * 2. **Gridlines step in real milliseconds, not clock hours.** Same rule as
 *    `slots.ts`, same reason. Two consequences, both correct rather than
 *    defects: a spring-forward day has no 02:00 line because that hour did not
 *    happen, and a fall-back day has two lines reading 01:00 a full row apart
 *    because that hour happened twice.
 *
 * Positions come out as percentages rather than pixels, so nothing here has an
 * opinion about how tall a row is. `components/schedule/day-grid.tsx` turns
 * `windowMinutes` into a height.
 *
 * **What is deliberately absent: any notion of a free Slot.** A Slot's size is
 * a Service's duration and a Business holds several Services, so a grid built
 * out of one Service's Slots misdescribes every other. The axis is plain hours
 * and the gaps are simply empty.
 */

/** An Appointment as the day view renders it. */
export type DayAppointment = {
  id: string;
  name: string;
  serviceName: string;
  startsAt: Date;
  endsAt: Date;
  status: AppointmentStatus;
  /** Non-null means a human must clear it before Callzie acts again. */
  needsAttentionReason: NeedsAttentionReason | null;
};

/** One Appointment, positioned. Percentages of the window, from its top. */
export type DayBlock = {
  appointment: DayAppointment;
  topPercent: number;
  heightPercent: number;
  /** Any part of it falls outside Business Hours. */
  outsideHours: boolean;
  /** Callzie has flagged it as clashing with the connected Google Calendar. */
  collision: boolean;
};

/** One hour line, labelled with the wall clock at that instant. */
export type Gridline = {
  /** `"09:00"`. */
  label: string;
  topPercent: number;
};

/** A stretch of the window that is not inside Business Hours. */
export type ShadedBand = {
  topPercent: number;
  heightPercent: number;
};

export type DayLayout = {
  /** Opening and closing instants, or `null` when the Business is shut today. */
  hours: { opensAt: Date; closesAt: Date } | null;
  windowStart: Date;
  windowEnd: Date;
  /** Real minutes between the two, which a DST day makes ≠ the clock reading. */
  windowMinutes: number;
  gridlines: Gridline[];
  /** Ascending by start time. */
  blocks: DayBlock[];
  outsideHours: ShadedBand[];
};

export type DayLayoutInput = {
  /** The day being shown, in the Business's own zone. */
  date: CivilDate;
  /** IANA zone from `businesses.timezone`. */
  timezone: string;
  /** That weekday's window as wall clock, or `null` if closed. */
  hours: { opensAt: string; closesAt: string } | null;
  appointments: DayAppointment[];
};

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

/*
  A ceiling on how many lines one day may draw, mirroring MAX_DAYS in
  lib/availability/slots.ts. A day cannot honestly need more than this, and it
  makes the loop obviously finite whatever the data says.
*/
const MAX_GRIDLINES = 48;

/**
 * The day, laid out — or `null` when there is nothing to draw at all, which
 * means a closed day with no Appointments on it. The caller renders
 * `components/schedule/closed-day.tsx` for that case rather than an empty grid.
 */
export function dayLayout({
  date,
  timezone,
  hours,
  appointments,
}: DayLayoutInput): DayLayout | null {
  const window = hours
    ? {
        opensAt: zonedTimeToInstant(
          { ...date, ...parseWallTime(hours.opensAt) },
          timezone,
        ),
        closesAt: zonedTimeToInstant(
          { ...date, ...parseWallTime(hours.closesAt) },
          timezone,
        ),
      }
    : null;

  const sorted = [...appointments].sort(
    (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
  );

  if (!window && sorted.length === 0) return null;

  // Every instant the window must reach. Business Hours give it its usual
  // shape; Appointments can only widen it, which is what makes an out-of-hours
  // booking visible in place rather than clipped off an edge.
  const edges: number[] = [];
  if (window) edges.push(window.opensAt.getTime(), window.closesAt.getTime());
  for (const appointment of sorted) {
    edges.push(appointment.startsAt.getTime(), appointment.endsAt.getTime());
  }

  const windowStart = floorToHour(new Date(Math.min(...edges)), timezone);
  let windowEnd = ceilToHour(new Date(Math.max(...edges)), timezone);

  // Degenerate input — a zero-length window — would divide by zero below and
  // fill the screen with NaN. One hour is an arbitrary but harmless floor.
  if (windowEnd.getTime() <= windowStart.getTime()) {
    windowEnd = new Date(windowStart.getTime() + MS_PER_HOUR);
  }

  const total = windowEnd.getTime() - windowStart.getTime();
  const percentOf = (instant: Date): number =>
    clampPercent(((instant.getTime() - windowStart.getTime()) / total) * 100);

  return {
    hours: window,
    windowStart,
    windowEnd,
    windowMinutes: total / MS_PER_MINUTE,
    gridlines: gridlinesFor(windowStart, windowEnd, total, timezone),
    blocks: [],
    outsideHours: [],
  };
}

/**
 * One line per real hour from the window's start.
 *
 * Stepping in milliseconds rather than incrementing a clock hour is the whole
 * point — see this module's header. The label is read back off each instant, so
 * a day that skips or repeats an hour says so.
 */
function gridlinesFor(
  windowStart: Date,
  windowEnd: Date,
  total: number,
  timezone: string,
): Gridline[] {
  const lines: Gridline[] = [];
  for (
    let t = windowStart.getTime();
    t <= windowEnd.getTime() && lines.length < MAX_GRIDLINES;
    t += MS_PER_HOUR
  ) {
    lines.push({
      label: clockInZone(new Date(t), timezone),
      topPercent: ((t - windowStart.getTime()) / total) * 100,
    });
  }
  return lines;
}

/**
 * `instant` moved back to the whole hour on the Business's clock — but never
 * forward.
 *
 * The guard is rule 1 in this module's header. It is cheap, and without it a
 * DST gap can turn "round down" into "round up" and clip the day.
 */
function floorToHour(instant: Date, timezone: string): Date {
  const parts = partsInZone(instant, timezone);
  if (parts.minute === 0 && parts.second === 0) return instant;

  const floored = zonedTimeToInstant({ ...parts, minute: 0 }, timezone);
  return floored.getTime() < instant.getTime() ? floored : instant;
}

/**
 * `instant` moved on to the next whole hour on the Business's clock — but never
 * backward.
 *
 * One real hour after the floor, rather than `hour + 1` on the clock. That is
 * what makes 23:xx land on the next day, and what makes a spring-forward
 * morning step 01:xx to 03:00 rather than to an hour that does not exist.
 */
function ceilToHour(instant: Date, timezone: string): Date {
  const floored = floorToHour(instant, timezone);
  if (floored.getTime() === instant.getTime()) return instant;

  const ceiled = new Date(floored.getTime() + MS_PER_HOUR);
  return ceiled.getTime() > instant.getTime() ? ceiled : instant;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}
```

Note: `percentOf` is declared and unused at this point, which lint will flag. Task 4 uses it. If `npm run lint` is part of your loop, add the blocks in Task 4 before linting, or temporarily inline it — do not delete it.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run lib/schedule/day-layout.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/schedule/day-layout.ts lib/schedule/day-layout.test.ts
git commit -m "Lay out a Schedule day's window and hour gridlines"
```

---

## Task 4: `day-layout.ts` — the blocks and the shaded bands

**Files:**
- Modify: `lib/schedule/day-layout.ts`
- Test: `lib/schedule/day-layout.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `lib/schedule/day-layout.test.ts`:

```ts
describe("dayLayout — the blocks", () => {
  it("positions a block by its start and its duration", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: NINE_TO_FIVE,
      appointments: [
        // 11:30-12:00 Kolkata, inside a 09:00-17:00 window.
        appointment({
          id: "appt-mid",
          startsAt: new Date("2026-08-19T06:00:00.000Z"),
          endsAt: new Date("2026-08-19T06:30:00.000Z"),
        }),
      ],
    });

    const block = layout!.blocks[0]!;
    // Two and a half hours into an eight-hour window.
    expect(block.topPercent).toBeCloseTo(31.25, 5);
    // Thirty minutes of four hundred and eighty.
    expect(block.heightPercent).toBeCloseTo(6.25, 5);
    expect(block.outsideHours).toBe(false);
    expect(block.collision).toBe(false);
  });

  it("returns blocks in start order however they arrive", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: NINE_TO_FIVE,
      appointments: [
        appointment({
          id: "later",
          startsAt: new Date("2026-08-19T06:00:00.000Z"),
          endsAt: new Date("2026-08-19T06:30:00.000Z"),
        }),
        appointment({
          id: "earlier",
          startsAt: new Date("2026-08-19T03:30:00.000Z"),
          endsAt: new Date("2026-08-19T04:15:00.000Z"),
        }),
      ],
    });

    expect(layout?.blocks.map((b) => b.appointment.id)).toEqual([
      "earlier",
      "later",
    ]);
  });

  it("never lets a block run past the window", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: NINE_TO_FIVE,
      appointments: [
        appointment({
          startsAt: new Date("2026-08-19T03:30:00.000Z"),
          endsAt: new Date("2026-08-19T11:30:00.000Z"),
        }),
      ],
    });

    for (const block of layout!.blocks) {
      expect(block.topPercent).toBeGreaterThanOrEqual(0);
      expect(block.topPercent + block.heightPercent).toBeLessThanOrEqual(100);
    }
  });

  it("marks an Appointment that falls outside opening hours", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: NINE_TO_FIVE,
      // 08:00-08:45 Kolkata, before the doors open.
      appointments: [
        appointment({
          startsAt: new Date("2026-08-19T02:30:00.000Z"),
          endsAt: new Date("2026-08-19T03:15:00.000Z"),
        }),
      ],
    });

    expect(layout?.blocks[0]?.outsideHours).toBe(true);
  });

  it("treats every Appointment on a closed day as outside hours", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: null,
      appointments: [
        appointment({
          startsAt: new Date("2026-08-19T08:30:00.000Z"),
          endsAt: new Date("2026-08-19T09:15:00.000Z"),
        }),
      ],
    });

    expect(layout?.blocks[0]?.outsideHours).toBe(true);
  });

  it("marks a Collision, and only a Collision", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: NINE_TO_FIVE,
      appointments: [
        appointment({
          id: "collided",
          needsAttentionReason: "collision",
          startsAt: new Date("2026-08-19T03:30:00.000Z"),
          endsAt: new Date("2026-08-19T04:15:00.000Z"),
        }),
        appointment({
          id: "failed-to-book",
          needsAttentionReason: "book_failed",
          startsAt: new Date("2026-08-19T06:00:00.000Z"),
          endsAt: new Date("2026-08-19T06:30:00.000Z"),
        }),
      ],
    });

    expect(layout?.blocks.map((b) => b.collision)).toEqual([true, false]);
  });
});

describe("dayLayout — the shaded bands", () => {
  it("shades nothing when the window is exactly Business Hours", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: NINE_TO_FIVE,
      appointments: [],
    });

    expect(layout?.outsideHours).toEqual([]);
  });

  it("shades the stretch before opening", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: NINE_TO_FIVE,
      // 08:00-08:45 Kolkata. The window becomes 08:00-17:00, nine hours.
      appointments: [
        appointment({
          startsAt: new Date("2026-08-19T02:30:00.000Z"),
          endsAt: new Date("2026-08-19T03:15:00.000Z"),
        }),
      ],
    });

    expect(layout?.outsideHours).toHaveLength(1);
    expect(layout?.outsideHours[0]?.topPercent).toBe(0);
    // One hour of nine.
    expect(layout?.outsideHours[0]?.heightPercent).toBeCloseTo(11.1111, 3);
  });

  it("shades the stretch after closing", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: NINE_TO_FIVE,
      // 18:00-18:45 Kolkata. The window becomes 09:00-19:00, ten hours.
      appointments: [
        appointment({
          startsAt: new Date("2026-08-19T12:30:00.000Z"),
          endsAt: new Date("2026-08-19T13:15:00.000Z"),
        }),
      ],
    });

    expect(layout?.outsideHours).toHaveLength(1);
    // Closing is eight hours into a ten-hour window.
    expect(layout?.outsideHours[0]?.topPercent).toBeCloseTo(80, 5);
    expect(layout?.outsideHours[0]?.heightPercent).toBeCloseTo(20, 5);
  });

  it("shades the whole window on a closed day", () => {
    const layout = dayLayout({
      date: WEDNESDAY,
      timezone: KOLKATA,
      hours: null,
      appointments: [
        appointment({
          startsAt: new Date("2026-08-19T08:30:00.000Z"),
          endsAt: new Date("2026-08-19T09:15:00.000Z"),
        }),
      ],
    });

    expect(layout?.outsideHours).toEqual([
      { topPercent: 0, heightPercent: 100 },
    ]);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run lib/schedule/day-layout.test.ts`
Expected: FAIL — the new tests read `layout.blocks[0]` on an empty array and `outsideHours` on an empty array. Errors like `Cannot read properties of undefined (reading 'topPercent')`. The nine tests from Task 3 still pass.

- [ ] **Step 3: Implement it**

In `lib/schedule/day-layout.ts`, replace the `return` at the end of `dayLayout` with:

```ts
  return {
    hours: window,
    windowStart,
    windowEnd,
    windowMinutes: total / MS_PER_MINUTE,
    gridlines: gridlinesFor(windowStart, windowEnd, total, timezone),
    blocks: sorted.map((appointment) => {
      const top = percentOf(appointment.startsAt);
      const bottom = percentOf(appointment.endsAt);
      return {
        appointment,
        topPercent: top,
        // From the clamped edges, not from the raw duration, so a block can
        // never overhang the window it was clamped into.
        heightPercent: Math.max(bottom - top, 0),
        outsideHours: window
          ? appointment.startsAt.getTime() < window.opensAt.getTime() ||
            appointment.endsAt.getTime() > window.closesAt.getTime()
          : // Nothing is inside hours on a day the Business is shut.
            true,
        collision: appointment.needsAttentionReason === "collision",
      };
    }),
    outsideHours: shadedBands(window, percentOf),
  };
}

/**
 * The stretches of the window that are not Business Hours.
 *
 * At most two on an open day — before opening, after closing — because
 * `lib/settings/hours-input.ts` rejects overnight windows, so a weekday's
 * opening hours are one contiguous run with no hole in the middle.
 *
 * A closed day is one band covering everything. That is what makes an
 * Appointment booked onto a shut Saturday read as unusual at a glance rather
 * than looking like an ordinary morning.
 */
function shadedBands(
  window: { opensAt: Date; closesAt: Date } | null,
  percentOf: (instant: Date) => number,
): ShadedBand[] {
  if (!window) return [{ topPercent: 0, heightPercent: 100 }];

  const bands: ShadedBand[] = [];
  const opensAt = percentOf(window.opensAt);
  const closesAt = percentOf(window.closesAt);

  if (opensAt > 0) bands.push({ topPercent: 0, heightPercent: opensAt });
  if (closesAt < 100) {
    bands.push({ topPercent: closesAt, heightPercent: 100 - closesAt });
  }
  return bands;
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run lib/schedule/day-layout.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 5: Check types and lint**

Run: `npm run typecheck && npm run lint`
Expected: both clean. `percentOf` is now used, so the unused-variable warning from Task 3 is gone.

- [ ] **Step 6: Commit**

```bash
git add lib/schedule/day-layout.ts lib/schedule/day-layout.test.ts
git commit -m "Position Schedule blocks and shade time outside Business Hours"
```

---

## Task 5: Move the status colours somewhere two screens can reach

`STATUS_STYLES` lives inside `components/overview/status-pill.tsx` today. The Appointment block needs the same seven colours for its left bar. Two screens deriving them independently is how `cancelled` ends up slate on one and red on the other.

The field is renamed `dot` → `background` in the move, because it is no longer only a dot.

**Files:**
- Create: `lib/appointments/status-style.ts`
- Modify: `components/overview/status-pill.tsx`

- [ ] **Step 1: Create the shared module**

Create `lib/appointments/status-style.ts`:

```ts
import type { AppointmentStatus } from "@/lib/db/schema";

/**
 * Which colour and which word each Appointment status gets (SPEC.md §11.2).
 *
 * Lifted out of `components/overview/status-pill.tsx` when the Schedule day
 * view needed the same seven colours for a block's left bar. Two screens
 * deriving this independently is how `cancelled` ends up slate on one and red
 * on the other.
 *
 * Every colour below is a token already declared in `app/globals.css`. This
 * module introduces none — the `--color-*: initial` reset in that file means an
 * off-token colour would not compile. The values are literal class strings for
 * the same reason: Tailwind scans source text, and a class assembled at runtime
 * is a class that never gets generated.
 *
 * **§11.2 names colours for five statuses and the schema has seven**, so two
 * were decided here and are written down so the next screen that needs them
 * does not re-derive them differently:
 *
 * - `pending` uses `text-muted`. Nothing has happened to this Appointment yet,
 *   and a status that is merely the default should not draw the eye.
 * - `cancelled` uses the `unreachable` slate rather than the `declined` red. A
 *   cancellation is a neutral outcome; red is reserved for the person saying no.
 *
 * A colour is never the only signal. Both callers render `label` beside it:
 * about one in twelve men cannot distinguish the green from the amber, and the
 * word is what they read.
 */

export type StatusStyle = {
  /** A Tailwind background class — the pill's dot, the block's left bar. */
  background: string;
  label: string;
};

export const STATUS_STYLES: Record<AppointmentStatus, StatusStyle> = {
  pending: { background: "bg-text-muted", label: "Pending" },
  // §11.2: "in-progress uses accent".
  calling: { background: "bg-accent", label: "Calling" },
  confirmed: { background: "bg-confirmed", label: "Confirmed" },
  rescheduled: { background: "bg-rescheduled", label: "Rescheduled" },
  declined: { background: "bg-declined", label: "Declined" },
  cancelled: { background: "bg-unreachable", label: "Cancelled" },
  unreachable: { background: "bg-unreachable", label: "Unreachable" },
};
```

- [ ] **Step 2: Point the pill at it**

Replace the whole of `components/overview/status-pill.tsx` with:

```tsx
import { STATUS_STYLES } from "@/lib/appointments/status-style"
import type { AppointmentStatus } from "@/lib/db/schema"

/**
 * An Appointment's status as a coloured dot plus a label (SPEC.md §11.2).
 *
 * The colours themselves live in `lib/appointments/status-style.ts`, shared
 * with the Schedule day view's blocks — see that file for why `pending` and
 * `cancelled` render the way they do.
 *
 * A dot plus a word, never colour alone: about one in twelve men cannot
 * distinguish the green from the amber, and the label is what they read.
 */
export function StatusPill({ status }: { status: AppointmentStatus }) {
  const style = STATUS_STYLES[status]

  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-line px-2 py-1 text-table text-text">
      <span className={`size-2 rounded-full ${style.background}`} aria-hidden />
      {style.label}
    </span>
  )
}
```

- [ ] **Step 3: Check nothing else read the old shape**

Run: `npx tsc --noEmit`
Expected: clean. If anything else imported `STATUS_STYLES` from the component, this is where it surfaces — point it at the new module and rename `dot` to `background`.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS. Nothing tests the pill directly, so this is a regression check that the move broke no import.

- [ ] **Step 5: Commit**

```bash
git add lib/appointments/status-style.ts components/overview/status-pill.tsx
git commit -m "Share the Appointment status colours between two screens"
```

---

## Task 6: `load-day.ts` — the two queries

**Files:**
- Create: `lib/schedule/load-day.ts`
- Test: `lib/schedule/load-day.test.ts`

This is the one database-backed test. It follows `lib/business/list-appointments.test.ts`: provision a User under a test-only Clerk id, build a Business by hand, clean up everything it wrote.

- [ ] **Step 1: Write the failing test**

Create `lib/schedule/load-day.test.ts`:

```ts
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { provisionUser } from "@/lib/auth/provision-user";
import { db, schema } from "@/lib/db";
import { loadScheduleDay } from "@/lib/schedule/load-day";

const CLERK_ID = "user_test_load_schedule_day";
const OTHER_CLERK_ID = "user_test_load_schedule_day_other";
const KOLKATA = "Asia/Kolkata";

/** 19 August 2026, a Wednesday. */
const WEDNESDAY = { year: 2026, month: 8, day: 19 };
/** 23 August 2026, a Sunday — the Business is closed. */
const SUNDAY = { year: 2026, month: 8, day: 23 };

let businessId: string;
let otherBusinessId: string;
let serviceId: string;

async function makeBusiness(clerkId: string): Promise<string> {
  const user = await provisionUser({ clerkId, email: `${clerkId}@test.local` });
  const [business] = await db
    .insert(schema.businesses)
    .values({
      userId: user.id,
      name: "Test Business",
      businessType: "salon",
      timezone: KOLKATA,
    })
    .returning({ id: schema.businesses.id });
  return business!.id;
}

async function cleanup(clerkId: string) {
  const user = await db.query.users.findFirst({
    where: eq(schema.users.clerkId, clerkId),
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
      .delete(schema.businessHours)
      .where(eq(schema.businessHours.businessId, business.id));
    await db
      .delete(schema.services)
      .where(eq(schema.services.businessId, business.id));
    await db.delete(schema.businesses).where(eq(schema.businesses.id, business.id));
  }
  await db.delete(schema.users).where(eq(schema.users.id, user.id));
}

beforeAll(async () => {
  await cleanup(CLERK_ID);
  await cleanup(OTHER_CLERK_ID);

  businessId = await makeBusiness(CLERK_ID);
  otherBusinessId = await makeBusiness(OTHER_CLERK_ID);

  const [service] = await db
    .insert(schema.services)
    .values({ businessId, name: "Cleaning", durationMinutes: 45 })
    .returning({ id: schema.services.id });
  serviceId = service!.id;

  // Open 09:00-17:00 on Wednesday only. Every other weekday is closed.
  await db
    .insert(schema.businessHours)
    .values({ businessId, weekday: 3, opensAt: "09:00", closesAt: "17:00" });

  await db.insert(schema.appointments).values([
    // Wednesday 09:00-09:45 Kolkata, confirmed.
    {
      businessId,
      serviceId,
      name: "Priya Sharma",
      phoneE164: "+12025550100",
      startsAt: new Date("2026-08-19T03:30:00.000Z"),
      endsAt: new Date("2026-08-19T04:15:00.000Z"),
      status: "confirmed",
    },
    // Wednesday 11:00-11:45, cancelled — frees its Slot, must not appear.
    {
      businessId,
      serviceId,
      name: "Cancelled Person",
      phoneE164: "+12025550101",
      startsAt: new Date("2026-08-19T05:30:00.000Z"),
      endsAt: new Date("2026-08-19T06:15:00.000Z"),
      status: "cancelled",
    },
    // Wednesday 13:00-13:45, declined — also frees its Slot.
    {
      businessId,
      serviceId,
      name: "Declined Person",
      phoneE164: "+12025550102",
      startsAt: new Date("2026-08-19T07:30:00.000Z"),
      endsAt: new Date("2026-08-19T08:15:00.000Z"),
      status: "declined",
    },
    // Wednesday 15:00-15:45, flagged as a Collision.
    {
      businessId,
      serviceId,
      name: "Collided Person",
      phoneE164: "+12025550103",
      startsAt: new Date("2026-08-19T09:30:00.000Z"),
      endsAt: new Date("2026-08-19T10:15:00.000Z"),
      status: "confirmed",
      needsAttentionReason: "collision",
    },
    // Thursday 09:00-09:45 — the next day, must not appear on Wednesday.
    {
      businessId,
      serviceId,
      name: "Tomorrow Person",
      phoneE164: "+12025550104",
      startsAt: new Date("2026-08-20T03:30:00.000Z"),
      endsAt: new Date("2026-08-20T04:15:00.000Z"),
      status: "pending",
    },
    // Sunday 14:00-14:45 — a closed day with a booking on it.
    {
      businessId,
      serviceId,
      name: "Sunday Person",
      phoneE164: "+12025550105",
      startsAt: new Date("2026-08-23T08:30:00.000Z"),
      endsAt: new Date("2026-08-23T09:15:00.000Z"),
      status: "pending",
    },
  ]);
});

afterAll(async () => {
  await cleanup(CLERK_ID);
  await cleanup(OTHER_CLERK_ID);
});

describe("loadScheduleDay", () => {
  it("returns that day's Slot-holding Appointments and nothing else", async () => {
    const layout = await loadScheduleDay({
      businessId,
      timezone: KOLKATA,
      date: WEDNESDAY,
    });

    expect(layout?.blocks.map((b) => b.appointment.name)).toEqual([
      "Priya Sharma",
      "Collided Person",
    ]);
  });

  it("reads the weekday's Business Hours", async () => {
    const layout = await loadScheduleDay({
      businessId,
      timezone: KOLKATA,
      date: WEDNESDAY,
    });

    // 09:00 and 17:00 Kolkata. `pg` hands back "09:00:00"; if toWallTime were
    // skipped, parseWallTime would throw rather than quietly misread it.
    expect(layout?.hours?.opensAt.toISOString()).toBe("2026-08-19T03:30:00.000Z");
    expect(layout?.hours?.closesAt.toISOString()).toBe("2026-08-19T11:30:00.000Z");
  });

  it("carries the Service name and the attention reason", async () => {
    const layout = await loadScheduleDay({
      businessId,
      timezone: KOLKATA,
      date: WEDNESDAY,
    });

    const collided = layout!.blocks[1]!;
    expect(collided.appointment.serviceName).toBe("Cleaning");
    expect(collided.collision).toBe(true);
  });

  it("renders a closed day that still has a booking on it", async () => {
    const layout = await loadScheduleDay({
      businessId,
      timezone: KOLKATA,
      date: SUNDAY,
    });

    expect(layout?.hours).toBeNull();
    expect(layout?.blocks.map((b) => b.appointment.name)).toEqual([
      "Sunday Person",
    ]);
  });

  it("returns null for a closed day with nothing on it", async () => {
    // 30 August 2026, also a Sunday, with no Appointments.
    const layout = await loadScheduleDay({
      businessId,
      timezone: KOLKATA,
      date: { year: 2026, month: 8, day: 30 },
    });

    expect(layout).toBeNull();
  });

  it("never returns another Business's Appointments", async () => {
    const layout = await loadScheduleDay({
      businessId: otherBusinessId,
      timezone: KOLKATA,
      date: WEDNESDAY,
    });

    expect(layout).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run lib/schedule/load-day.test.ts`
Expected: FAIL — cannot resolve `@/lib/schedule/load-day`.

If `provisionUser`'s signature does not match the call above, open `lib/auth/provision-user.ts` and match it — it is the one thing in this test taken on trust.

- [ ] **Step 3: Implement it**

Create `lib/schedule/load-day.ts`:

```ts
import { and, asc, eq, gt, inArray, lt } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { SLOT_HOLDING_STATUSES } from "@/lib/db/schema";
import { dayLayout, type DayLayout } from "@/lib/schedule/day-layout";
import { toWallTime } from "@/lib/settings/weekdays";
import {
  addCalendarDays,
  weekdayOf,
  zonedTimeToInstant,
  type CivilDate,
} from "@/lib/time/zone";

/**
 * One day of the Schedule screen, read and laid out.
 *
 * The loader half of the pair `lib/availability/find.ts` models: two queries,
 * then straight into the pure core. Nothing is decided here.
 *
 * **Why the Appointment query uses the civil day rather than the drawn
 * window.** The window stretches to hold Appointments that fall outside
 * Business Hours, so it cannot be computed until the Appointments are known —
 * and the Appointments cannot be queried by a window that does not exist yet.
 * Midnight to midnight in the Business's own zone breaks the circle: it is a
 * superset of anything the stretched window can reach, so the core is free to
 * widen without a second round trip.
 *
 * An Appointment running across midnight overlaps both civil days and appears
 * whole on both, each day's window stretching to hold it. That is the honest
 * answer, and it is rare — `lib/settings/hours-input.ts` rejects overnight
 * Business Hours, so nothing routinely books across the boundary.
 *
 * **Not `listAppointments`.** That one is capped at 20 rows, has no date
 * filter, and does not carry `needs_attention_reason`. Widening it would make
 * Overview pay for a column it never renders.
 */

export type LoadScheduleDayInput = {
  businessId: string;
  /** IANA zone from `businesses.timezone`. */
  timezone: string;
  /** The day to draw, in that zone. */
  date: CivilDate;
};

/** `null` means there is nothing to draw — a closed day with no Appointments. */
export async function loadScheduleDay({
  businessId,
  timezone,
  date,
}: LoadScheduleDayInput): Promise<DayLayout | null> {
  const dayStart = zonedTimeToInstant({ ...date, hour: 0, minute: 0 }, timezone);
  const dayEnd = zonedTimeToInstant(
    { ...addCalendarDays(date, 1), hour: 0, minute: 0 },
    timezone,
  );

  const [hoursRows, appointments] = await Promise.all([
    db
      .select({
        opensAt: schema.businessHours.opensAt,
        closesAt: schema.businessHours.closesAt,
      })
      .from(schema.businessHours)
      .where(
        and(
          eq(schema.businessHours.businessId, businessId),
          eq(schema.businessHours.weekday, weekdayOf(date)),
        ),
      ),

    db
      .select({
        id: schema.appointments.id,
        name: schema.appointments.name,
        serviceName: schema.services.name,
        startsAt: schema.appointments.startsAt,
        endsAt: schema.appointments.endsAt,
        status: schema.appointments.status,
        needsAttentionReason: schema.appointments.needsAttentionReason,
      })
      .from(schema.appointments)
      /*
        An explicit innerJoin rather than the relational query API, for the
        reason lib/business/list-appointments.ts gives: no relations() are
        declared anywhere in this repo, and adding them is a schema-wide
        convention change rather than a feature ticket.
      */
      .innerJoin(
        schema.services,
        eq(schema.appointments.serviceId, schema.services.id),
      )
      .where(
        and(
          eq(schema.appointments.businessId, businessId),
          /*
            Exactly the statuses the appointments_no_overlap constraint counts.
            Imported, never re-listed: a second copy of this list is the drift
            lib/db/schema.ts exists to prevent.

            It is also what makes the layout simple. `declined` and `cancelled`
            free their Slot, so another Appointment can legally sit on top of
            one — and if they were drawn, two blocks could occupy the same
            minutes and the grid would need side-by-side lanes. Excluding them
            lets the database guarantee blocks never overlap.
          */
          inArray(schema.appointments.status, [...SLOT_HOLDING_STATUSES]),
          // Half-open overlap with the civil day, matching tstzrange.
          lt(schema.appointments.startsAt, dayEnd),
          gt(schema.appointments.endsAt, dayStart),
        ),
      )
      // Covered by appointments_business_id_starts_at_idx.
      .orderBy(asc(schema.appointments.startsAt)),
  ]);

  // business_hours_business_weekday_uniq makes this at most one row.
  const hours = hoursRows[0];

  return dayLayout({
    date,
    timezone,
    hours: hours
      ? {
          // `pg` renders a `time` column as "09:00:00"; the pure core expects
          // "09:00". Normalising on the way out of the database is what
          // toWallTime is for.
          opensAt: toWallTime(hours.opensAt),
          closesAt: toWallTime(hours.closesAt),
        }
      : null,
    appointments,
  });
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run lib/schedule/load-day.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/schedule/load-day.ts lib/schedule/load-day.test.ts
git commit -m "Read one Schedule day out of Postgres"
```

---

## Task 7: The closed-day card

The smallest component first, so the rest have something to render against.

**Files:**
- Create: `components/schedule/closed-day.tsx`

- [ ] **Step 1: Write it**

Create `components/schedule/closed-day.tsx`:

```tsx
import { weekdayLabel } from "@/lib/settings/weekdays"
import { weekdayOf, type CivilDate } from "@/lib/time/zone"

/**
 * A day with no Business Hours and no Appointments on it.
 *
 * A designed state rather than an empty grid. Drawing hour lines across a day
 * the Business is shut would say the day is open and quiet, which is a
 * different fact.
 *
 * Named after the weekday rather than the date — "Closed on Sundays" is the
 * standing rule, and it is the sentence that tells someone where to go and
 * change it.
 */
export function ClosedDay({ date }: { date: CivilDate }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-card border border-line bg-surface p-12">
      <p className="text-section text-text">
        Closed on {weekdayLabel(weekdayOf(date))}s.
      </p>
      <p className="text-body text-text-muted">No appointments.</p>
    </div>
  )
}
```

- [ ] **Step 2: Check it compiles**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add components/schedule/closed-day.tsx
git commit -m "Add the Schedule closed-day card"
```

---

## Task 8: The Appointment block

**Files:**
- Create: `components/schedule/appointment-block.tsx`

- [ ] **Step 1: Write it**

Create `components/schedule/appointment-block.tsx`:

```tsx
import { STATUS_STYLES } from "@/lib/appointments/status-style"
import type { DayBlock } from "@/lib/schedule/day-layout"
import { clockInZone } from "@/lib/time/zone"
import { cn } from "@/lib/utils"

/**
 * One Appointment, positioned in the day (SPEC.md §11.3).
 *
 * **Not a button, not a link.** #18 is deliberately read-only: no drag, no
 * click-to-book. If this screen starts growing interaction it should be cut,
 * because it competes with the Needs Attention surface (#15), which is the more
 * distinctive screen. An `<article>` rather than a `<div>` so a screen reader
 * announces each booking as its own thing.
 *
 * The percentages come from `lib/schedule/day-layout.ts` and are applied as
 * inline styles, which is the one place this app cannot use a token: a Tailwind
 * class is a fixed string in source, and every block has a different top.
 *
 * A block clips rather than grows. At 64px an hour a fifteen-minute Appointment
 * is sixteen pixels tall, and letting it push its neighbours down would put the
 * whole column out of step with the hour labels beside it.
 *
 * Status is a colour **and** a word, never colour alone — the reason
 * `lib/appointments/status-style.ts` gives.
 */

type AppointmentBlockProps = {
  block: DayBlock
  /** The Business's IANA zone — times mean nothing without it. */
  timezone: string
}

export function AppointmentBlock({ block, timezone }: AppointmentBlockProps) {
  const { appointment } = block
  const style = STATUS_STYLES[appointment.status]

  return (
    <article
      className={cn(
        "absolute inset-x-1 flex gap-2 overflow-hidden rounded-control border bg-surface px-2 py-1",
        // Amber for a Collision, so the one thing needing a human stands out
        // from seven statuses that do not.
        block.collision ? "border-attention" : "border-line",
      )}
      style={{
        top: `${block.topPercent}%`,
        height: `${block.heightPercent}%`,
      }}
    >
      <span
        className={cn("w-[3px] shrink-0 rounded-full", style.background)}
        aria-hidden
      />

      <div className="min-w-0 flex-1">
        <p className="truncate text-table text-text">
          <span className="font-medium">{appointment.name}</span>{" "}
          <span className="text-text-muted">{style.label}</span>
        </p>

        <p className="truncate font-mono text-table text-text-muted">
          {clockInZone(appointment.startsAt, timezone)}–
          {clockInZone(appointment.endsAt, timezone)}
          {/* The Service is the first thing to go at 375px: the name and the
              time are what identify the booking. */}
          <span className="hidden font-sans sm:inline">
            {" "}
            · {appointment.serviceName}
          </span>
        </p>

        {block.collision && (
          <p className="truncate text-table text-attention">Collision</p>
        )}
        {!block.collision && block.outsideHours && (
          <p className="truncate text-table text-text-muted">Outside hours</p>
        )}
      </div>
    </article>
  )
}
```

- [ ] **Step 2: Check it compiles**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 3: Commit**

```bash
git add components/schedule/appointment-block.tsx
git commit -m "Add the Schedule Appointment block"
```

---

## Task 9: The grid

**Files:**
- Create: `components/schedule/day-grid.tsx`

- [ ] **Step 1: Write it**

Create `components/schedule/day-grid.tsx`:

```tsx
import { AppointmentBlock } from "@/components/schedule/appointment-block"
import type { DayLayout } from "@/lib/schedule/day-layout"

/**
 * The day as a column of time (SPEC.md §11.3).
 *
 * A **server** component, like `components/overview/appointments-table.tsx` and
 * for the same reason: every time on this screen is formatted in the Business's
 * own timezone, and doing that on the server means one `Intl` pass and no
 * chance of a hydration mismatch between the viewer's clock and the Business's.
 *
 * The column's height is the only place pixels appear. `windowMinutes` is real
 * minutes, so a fall-back day is genuinely one row taller than a normal one and
 * a spring-forward day one shorter — which is the truth about those days.
 *
 * **What is not drawn: free Slots.** Gaps are gaps. A Slot's size is a
 * Service's duration and a Business holds several, so any free-Slot band would
 * be right for one Service and wrong for the rest.
 */

/**
 * One hour of the day, in pixels. Enough that a 15-minute Appointment still
 * gets a readable 16px block, and that eight opening hours fit a laptop screen
 * without scrolling.
 */
const PIXELS_PER_HOUR = 64

type DayGridProps = {
  layout: DayLayout
  /** The Business's IANA zone — times mean nothing without it. */
  timezone: string
}

export function DayGrid({ layout, timezone }: DayGridProps) {
  const height = Math.round((layout.windowMinutes / 60) * PIXELS_PER_HOUR)

  return (
    <section className="overflow-hidden rounded-card border border-line bg-surface">
      <div className="flex" style={{ height: `${height}px` }}>
        {/*
          The hour gutter, hidden from screen readers: every block already
          carries its own start and end in text, so reading twenty-four bare
          numbers first would only get in the way.
        */}
        <div
          className="relative w-14 shrink-0 border-r border-line"
          aria-hidden
        >
          {layout.gridlines.map((line, index) => (
            <span
              key={index}
              className="absolute right-2 font-mono text-table text-text-muted"
              style={{ top: `${line.topPercent}%` }}
            >
              {line.label}
            </span>
          ))}
        </div>

        <div className="relative flex-1">
          {/* Shading first, so lines and blocks sit on top of it. */}
          {layout.outsideHours.map((band, index) => (
            <div
              key={index}
              className="absolute inset-x-0 bg-bg"
              style={{
                top: `${band.topPercent}%`,
                height: `${band.heightPercent}%`,
              }}
              aria-hidden
            />
          ))}

          {layout.gridlines.map((line, index) => (
            <div
              key={index}
              className="absolute inset-x-0 border-t border-line"
              style={{ top: `${line.topPercent}%` }}
              aria-hidden
            />
          ))}

          {layout.blocks.map((block) => (
            <AppointmentBlock
              key={block.appointment.id}
              block={block}
              timezone={timezone}
            />
          ))}
        </div>
      </div>

      {/*
        An open day with nothing booked still draws its grid. The shape of the
        day is the information; hiding it would say less than showing it empty.
      */}
      {layout.blocks.length === 0 && (
        <p className="border-t border-line p-4 text-table text-text-muted">
          No appointments.
        </p>
      )}
    </section>
  )
}
```

- [ ] **Step 2: Check it compiles**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

- [ ] **Step 3: Commit**

```bash
git add components/schedule/day-grid.tsx
git commit -m "Add the Schedule day grid"
```

---

## Task 10: The day nav

**Files:**
- Create: `components/schedule/day-nav.tsx`

- [ ] **Step 1: Write it**

Create `components/schedule/day-nav.tsx`:

```tsx
import { ChevronLeft, ChevronRight } from "lucide-react"
import Link from "next/link"

import { formatDayHeading, scheduleHref } from "@/lib/schedule/day-param"
import { addCalendarDays, clockInZone, type CivilDate } from "@/lib/time/zone"

/**
 * Which day the Schedule is showing, and the three links that change it.
 *
 * **Plain links, deliberately.** They are the only interactive elements on this
 * screen, and being links rather than buttons is what keeps the whole page a
 * Server Component with no client JavaScript — and what makes a day shareable
 * and bookmarkable. Changing which day you are looking at is navigation, not
 * booking, so #18's read-only rule holds.
 *
 * Today is `/schedule` with no param at all, rather than today's date spelled
 * out. That link stays correct after midnight without the page being
 * re-rendered.
 *
 * `addCalendarDays` for prev and next, not a subtraction in milliseconds:
 * adding a day is a calendar operation, and counting in absolute time lands on
 * the wrong date across a DST transition.
 */

type DayNavProps = {
  date: CivilDate
  /** The Business's IANA zone — times mean nothing without it. */
  timezone: string
  /** That weekday's opening window, or null when the Business is shut. */
  hours: { opensAt: Date; closesAt: Date } | null
  appointmentCount: number
}

export function DayNav({
  date,
  timezone,
  hours,
  appointmentCount,
}: DayNavProps) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4">
      <nav aria-label="Choose a day" className="flex items-center gap-2">
        <DayLink href={scheduleHref(addCalendarDays(date, -1))} label="Previous day">
          <ChevronLeft className="size-4" aria-hidden />
        </DayLink>
        <DayLink href="/schedule" label="Today">
          Today
        </DayLink>
        <DayLink href={scheduleHref(addCalendarDays(date, 1))} label="Next day">
          <ChevronRight className="size-4" aria-hidden />
        </DayLink>
      </nav>

      <div className="flex flex-col items-end gap-1">
        <h2 className="text-section font-medium text-text">
          {formatDayHeading(date, timezone)}
        </h2>
        <p className="font-mono text-table text-text-muted">
          {summarise(hours, appointmentCount, timezone)}
        </p>
      </div>
    </header>
  )
}

/**
 * What the line under the date says.
 *
 * A closed day with bookings on it names the count, because that is the
 * combination worth noticing — Business Hours can be narrowed after
 * Appointments are booked, and `lib/settings/hours-conflicts.ts` exists because
 * Settings only warns about it rather than moving anything.
 */
function summarise(
  hours: { opensAt: Date; closesAt: Date } | null,
  appointmentCount: number,
  timezone: string,
): string {
  if (hours) {
    return `Open ${clockInZone(hours.opensAt, timezone)} – ${clockInZone(hours.closesAt, timezone)}`
  }
  if (appointmentCount === 0) return "Closed"
  return `Closed · ${appointmentCount} appointment${appointmentCount === 1 ? "" : "s"}`
}

/** One nav link. `aria-label` because two of the three are icons only. */
function DayLink({
  href,
  label,
  children,
}: {
  href: string
  label: string
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="flex h-8 items-center rounded-control border border-line px-3 text-table text-text-muted transition-colors hover:bg-muted hover:text-text"
    >
      {children}
    </Link>
  )
}
```

- [ ] **Step 2: Check it compiles**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

If `Link href` rejects the string, Next 16's typed routes want a known route. `/schedule` is a real route and the query string is appended at runtime, so this should type-check — if it does not, the fix is to cast at the `scheduleHref` boundary, not to widen the component's prop.

- [ ] **Step 3: Commit**

```bash
git add components/schedule/day-nav.tsx
git commit -m "Add the Schedule day nav"
```

---

## Task 11: Wire up the page

**Files:**
- Modify: `app/(app)/schedule/page.tsx`

- [ ] **Step 1: Replace the placeholder**

Replace the whole of `app/(app)/schedule/page.tsx` with:

```tsx
import { ClosedDay } from "@/components/schedule/closed-day"
import { DayGrid } from "@/components/schedule/day-grid"
import { DayNav } from "@/components/schedule/day-nav"
import { requireBusiness } from "@/lib/business/require-business"
import { resolveDay, SCHEDULE_DATE_PARAM } from "@/lib/schedule/day-param"
import { loadScheduleDay } from "@/lib/schedule/load-day"

/**
 * Schedule — the read-only day view (SPEC.md §11.3, issue #18).
 *
 * A Server Component with no client JavaScript at all. The only interactive
 * elements on the page are the three links in `DayNav`: nothing is draggable,
 * nothing is clickable to book. SPEC.md is explicit that if this screen starts
 * growing interaction it should be cut, because it competes with the Needs
 * Attention surface (#15).
 *
 * `requireBusiness()` is React-`cache()`d and the shell layout above has
 * already called it, so it costs no second query.
 *
 * A Collision renders from `appointments.needs_attention_reason`. Nothing
 * writes that value yet — detecting Collisions against Google Calendar is #20 —
 * so the marker is present and currently silent. #20 lights it up by writing
 * one column and changes nothing here.
 */
export default async function SchedulePage({
  searchParams,
}: PageProps<"/schedule">) {
  const { business } = await requireBusiness()

  /*
    "Today" is resolved in the Business's own timezone rather than the server's
    or the viewer's, and `new Date()` is passed in rather than read inside, so
    the rule is testable at a boundary — see lib/schedule/day-param.ts.
  */
  const date = resolveDay(
    readParam((await searchParams)[SCHEDULE_DATE_PARAM]),
    new Date(),
    business.timezone,
  )

  const layout = await loadScheduleDay({
    businessId: business.id,
    timezone: business.timezone,
    date,
  })

  return (
    <div className="flex flex-col gap-6">
      <DayNav
        date={date}
        timezone={business.timezone}
        hours={layout?.hours ?? null}
        appointmentCount={layout?.blocks.length ?? 0}
      />

      {/*
        A null layout means a closed day with nothing on it — the one case that
        gets a card instead of a grid. A closed day *with* a booking still draws
        the grid, fully shaded, so the booking keeps its place in time.
      */}
      {layout ? (
        <DayGrid layout={layout} timezone={business.timezone} />
      ) : (
        <ClosedDay date={date} />
      )}
    </div>
  )
}

/**
 * A search param as a single string.
 *
 * A repeated query key (`?date=a&date=b`) arrives as an array, so this
 * collapses to the first entry rather than letting `string[]` reach a function
 * typed for `string | null`. The same guard `app/(app)/settings/page.tsx` uses.
 */
function readParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}
```

- [ ] **Step 2: Check the whole thing compiles and lints**

Run: `npm run typecheck && npm run lint`
Expected: both clean.

If `PageProps<"/schedule">` is not found, Next generates those types during `next dev` / `next build`. Run `npm run build` once to generate them, then re-run typecheck.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS, everything green.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/schedule/page.tsx"
git commit -m "Build the read-only Schedule day view (#18)"
```

---

## Task 12: Look at it

Tests do not tell you whether a screen is legible. This task is manual and it is not optional — "readable at a glance" and "holds up at 375px" are two of #18's five acceptance criteria and neither has an assertion.

**Files:** none.

- [ ] **Step 1: Start the app**

Run: `npm run dev`

Sign in and go to `/schedule`. A fresh account is seeded with five Appointments on the next open days after today, so use Next until you land on one.

- [ ] **Step 2: Walk the cases**

Check each of these. Note anything that looks wrong; do not fix it yet.

| Check | Where |
|---|---|
| An open day with bookings draws hour lines and places blocks at the right times | Any seeded day |
| Block text is readable — name, status, time | Same |
| An open day with nothing booked still draws the grid, plus "No appointments." | Next until you find one |
| A closed day with nothing on it shows the card, not a grid | Next to a weekday the Template leaves closed |
| Prev / Today / Next move a day at a time and Today returns to today | Click each |
| `?date=banana` lands on today rather than an error | Edit the URL |
| `?date=2026-02-30` does the same | Edit the URL |
| Nothing on the page responds to a click except the three links | Try clicking a block |

- [ ] **Step 3: Check 375px**

Open DevTools, set the viewport to 375 × 667.

| Check |
|---|
| No horizontal scrollbar anywhere on the page |
| The hour gutter is still readable and the labels do not wrap |
| Block text truncates with an ellipsis rather than overflowing |
| The Service name is gone from blocks; name and time remain |
| The day nav wraps rather than squashing |

- [ ] **Step 4: Check a Collision renders**

Nothing writes `needs_attention_reason` yet, so set one by hand. In `npm run db:studio`, or with psql against the dev database:

```sql
UPDATE appointments
SET needs_attention_reason = 'collision'
WHERE id = '<the id of an Appointment you can see>';
```

Reload. The block should take an amber border and a "Collision" line.

Undo it afterwards:

```sql
UPDATE appointments SET needs_attention_reason = NULL WHERE id = '<same id>';
```

- [ ] **Step 5: Fix anything you found, then commit**

```bash
git add -A
git commit -m "Polish the Schedule day view after a look at it"
```

If nothing needed changing, skip the commit.

---

## Task 13: Finish

- [ ] **Step 1: Run everything one more time**

```bash
npm run typecheck && npm run lint && npm test
```

Expected: all three clean. Do not proceed on a failure — read the output and fix it.

- [ ] **Step 2: Mark the design implemented**

In `docs/superpowers/specs/2026-08-19-schedule-read-only-day-view-design.md`, change the status line to:

```markdown
**Status:** Implemented. See `docs/superpowers/plans/2026-08-19-schedule-read-only-day-view.md`
```

- [ ] **Step 3: Commit and push**

```bash
git add docs/superpowers/specs/2026-08-19-schedule-read-only-day-view-design.md
git commit -m "Mark the #18 design implemented"
git push -u origin anushapundir/schedule-read-only-day-view
```

- [ ] **Step 4: Open the PR**

```bash
gh pr create --title "Schedule — read-only day view" --body "$(cat <<'EOF'
Closes #18.

`/schedule` now draws one day as a column of time: Business Hours as the shape
of the day, Appointments placed in it by start and duration, and a Collision
marked on the block it belongs to.

**Read-only, on purpose.** The only interactive elements on the page are three
links that change the day. No drag, no click-to-book.

Four decisions the issue left open:

- **The axis is hour gridlines, not Slot rows.** A Slot's size is a Service's
  duration and an account holds several, so no single Service's rows describe
  the day honestly.
- **The day lives in `?date`**, navigated by plain links, so the page stays a
  Server Component with no client JavaScript.
- **Collisions render from `needs_attention_reason`.** #20 still owns detecting
  them; this builds the surface they land on.
- **Only Slot-holding Appointments appear.** That makes the
  `appointments_no_overlap` constraint guarantee blocks never overlap, which
  removes lane layout entirely.

The hard part is `lib/schedule/day-layout.ts`, a pure core with no database and
no clock. Its tests pin the days that break naive calendars: a spring-forward
day has no 02:00 gridline, a fall-back day draws 01:00 twice, and window
rounding can only ever widen — never clip the Appointment it exists to hold.

Design: `docs/superpowers/specs/2026-08-19-schedule-read-only-day-view-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

Checked against the spec:

- **Every spec section has a task.** Pure core → Tasks 3-4. Loader → Task 6. `?date` → Task 2. Components → Tasks 7-10. The status-colour move → Task 5. Edge cases → covered by tests in Tasks 3, 4, 6 and by the manual walk in Task 12.
- **All five acceptance criteria are mapped.** Positioning → Task 4's tests. Status colours → Task 5 plus Task 8. Sensible closed and empty days → Tasks 3, 6, 7, 9. Genuinely read-only → Tasks 8 and 10, verified in Task 12. 375px → Task 12, which is why that task is not optional.
- **Names are consistent across tasks.** `dayLayout`, `loadScheduleDay`, `parseDayParam`, `resolveDay`, `scheduleHref`, `formatDayHeading`, `clockInZone`, `STATUS_STYLES.background`, `DayBlock.outsideHours`, `DayLayout.windowMinutes` — each defined once and used with the same spelling everywhere after.
- **One known rough edge, flagged in place:** `percentOf` is written in Task 3 and first used in Task 4, so lint will call it unused in between. Task 3 says so rather than leaving it to be discovered.
