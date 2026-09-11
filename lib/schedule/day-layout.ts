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
 * The pure core, in the sense `lib/availability/slots.ts` is one: no database,
 * no clock of its own, everything injected. That file argues the case at length
 * and the reasoning is identical here — the daylight-saving cases *are* the
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
 * 2. **Gridlines step in real milliseconds, not clock hours.** The same rule
 *    `lib/availability/slots.ts` follows, for the same reason. Two consequences,
 *    both correct rather than defects: a spring-forward day has no 02:00 line
 *    because that hour did not happen, and a fall-back day has two lines reading
 *    01:00 a full row apart because that hour happened twice.
 *
 * Positions come out as percentages rather than pixels, so nothing here has an
 * opinion about how tall an hour is. `components/schedule/day-grid.tsx` turns
 * `windowMinutes` into a height.
 *
 * **What is deliberately absent: any notion of a free Slot.** A Slot's size is a
 * Service's duration and a Business holds several Services, so a grid built out
 * of one Service's Slots would misdescribe every other. The axis is plain hours
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
  /**
   * Which column of the overlapping run this block sits in, counting from 0.
   * Two bookings at the same time get lanes 0 and 1 and sit side by side.
   */
  lane: number;
  /**
   * How many columns that run needs — 1 when nothing overlaps. A block's width
   * is `1 / laneCount` of the day column.
   */
  laneCount: number;
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
  lib/availability/slots.ts. No honest day needs more, and it makes the loop
  obviously finite whatever the data says.
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

  /*
    Start time first, then end, then id. The two tie-breaks are not decoration:
    a cancelled 10:00 booking and the 10:00 rebooking that replaced it start at
    the same instant, and without a tie-break the order — and so which of the
    two lands in the left lane — would follow whatever order the database
    happened to return them in, and could change between two renders of the
    same day.
  */
  const sorted = [...appointments].sort(
    (a, b) =>
      a.startsAt.getTime() - b.startsAt.getTime() ||
      a.endsAt.getTime() - b.endsAt.getTime() ||
      a.id.localeCompare(b.id),
  );

  if (!window && sorted.length === 0) return null;

  /*
    Every instant the window has to reach. Business Hours give it its usual
    shape; Appointments can only widen it, which is what makes a booking outside
    opening hours visible in place rather than clipped off an edge. That is an
    ordinary state, not a corruption — lib/settings/hours-conflicts.ts exists
    because narrowing Business Hours only warns, and never moves an Appointment.
  */
  const edges: number[] = [];
  if (window) edges.push(window.opensAt.getTime(), window.closesAt.getTime());
  for (const appointment of sorted) {
    edges.push(appointment.startsAt.getTime(), appointment.endsAt.getTime());
  }

  const windowStart = floorToHour(new Date(Math.min(...edges)), timezone);
  let windowEnd = ceilToHour(new Date(Math.max(...edges)), timezone);

  // Degenerate input — a zero-length window — would divide by zero below and
  // fill the screen with NaN. An hour is an arbitrary but harmless floor.
  if (windowEnd.getTime() <= windowStart.getTime()) {
    windowEnd = new Date(windowStart.getTime() + MS_PER_HOUR);
  }

  const total = windowEnd.getTime() - windowStart.getTime();
  const percentOf = (instant: Date): number =>
    clampPercent(((instant.getTime() - windowStart.getTime()) / total) * 100);

  const blocks: DayBlock[] = sorted.map((appointment) => {
    const top = percentOf(appointment.startsAt);
    const bottom = percentOf(appointment.endsAt);
    return {
      appointment,
      topPercent: top,
      // From the clamped edges rather than the raw duration, so a block can
      // never overhang the window it was just clamped into.
      heightPercent: Math.max(bottom - top, 0),
      // Filled in below, once every block is known.
      lane: 0,
      laneCount: 1,
      outsideHours: window
        ? appointment.startsAt.getTime() < window.opensAt.getTime() ||
          appointment.endsAt.getTime() > window.closesAt.getTime()
        : // Nothing is inside hours on a day the Business is shut.
          true,
      collision: appointment.needsAttentionReason === "collision",
    };
  });

  assignLanes(blocks);

  return {
    hours: window,
    windowStart,
    windowEnd,
    windowMinutes: total / MS_PER_MINUTE,
    gridlines: gridlinesFor(windowStart, windowEnd, total, timezone),
    blocks,
    outsideHours: shadedBands(window, percentOf),
  };
}

/**
 * Give every block a column to stand in, so two bookings at the same time sit
 * side by side instead of one painting over the other.
 *
 * Why this has to exist: a cancelled 10:00 booking and the 10:00 rebooking that
 * replaced it are two rows in the database and two blocks on the grid. Drawn at
 * the same position and the same width, the second one covers the first
 * completely — so the screen simply does not show you that the earlier booking
 * exists.
 *
 * The rule, in words: walk the blocks in start order and drop each one into the
 * left-most column that is already free at that moment. A column is free when
 * the last block in it has finished — an Appointment ending at 10:00 and one
 * starting at 10:00 do not overlap, so they share a column. When *every* column
 * is free the run of overlaps has ended, and the next block starts a fresh run
 * back at full width.
 *
 * `laneCount` is the number of columns the whole run needed, not the number in
 * use at one instant. Every block in a run therefore gets the same width, which
 * is what stops blocks changing width halfway down the column.
 *
 * Mutating the freshly-built array rather than returning a new one: these
 * objects were created a few lines above and nothing else has seen them yet, so
 * `dayLayout` stays a pure function of its input.
 */
function assignLanes(blocks: DayBlock[]): void {
  // The instant each open column becomes free, by column index.
  let laneEnds: number[] = [];
  // The blocks sharing those columns — they all take the final column count.
  let run: DayBlock[] = [];

  const endRun = (): void => {
    for (const block of run) block.laneCount = laneEnds.length;
    laneEnds = [];
    run = [];
  };

  for (const block of blocks) {
    const start = block.appointment.startsAt.getTime();
    const end = block.appointment.endsAt.getTime();

    // Nothing from the previous run is still running, so this block is not
    // overlapping anything and the run is over.
    if (laneEnds.length > 0 && laneEnds.every((laneEnd) => laneEnd <= start)) {
      endRun();
    }

    const free = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    block.lane = free === -1 ? laneEnds.length : free;
    laneEnds[block.lane] = end;
    run.push(block);
  }

  endRun();
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
 * The stretches of the window that are not Business Hours.
 *
 * At most two on an open day — before opening and after closing — because
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
