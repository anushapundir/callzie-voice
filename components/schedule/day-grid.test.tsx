import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ClosedDay } from "@/components/schedule/closed-day";
import { DayGrid } from "@/components/schedule/day-grid";
import { DayNav } from "@/components/schedule/day-nav";
import { dayLayout, type DayLayout } from "@/lib/schedule/day-layout";

/**
 * What the Schedule screen actually puts on the page.
 *
 * `lib/schedule/day-layout.test.ts` pins the arithmetic; this pins the markup
 * the arithmetic turns into, because two of #18's acceptance criteria are about
 * what renders rather than what is computed — "days outside Business Hours, and
 * empty days, render sensibly", and "it is genuinely read-only".
 *
 * `renderToStaticMarkup` rather than a testing library: every component here is
 * a synchronous Server Component with no state and no effects, so there is
 * nothing to hydrate and nothing to interact with. A string of HTML is the whole
 * output.
 */

const KOLKATA = "Asia/Kolkata";

/** 19 August 2026, a Wednesday. */
const WEDNESDAY = { year: 2026, month: 8, day: 19 };
const NINE_TO_FIVE = { opensAt: "09:00", closesAt: "17:00" };

/** 09:00-09:45 Kolkata. */
const MORNING = {
  id: "appt-morning",
  name: "Priya Sharma",
  serviceName: "Cleaning",
  startsAt: new Date("2026-08-19T03:30:00.000Z"),
  endsAt: new Date("2026-08-19T04:15:00.000Z"),
  status: "confirmed" as const,
  needsAttentionReason: null,
};

function layoutFor(
  hours: { opensAt: string; closesAt: string } | null,
  appointments: DayLayout["blocks"][number]["appointment"][],
): DayLayout {
  const layout = dayLayout({
    date: WEDNESDAY,
    timezone: KOLKATA,
    hours,
    appointments,
  });
  if (!layout) throw new Error("expected a layout for this fixture");
  return layout;
}

function grid(
  hours: { opensAt: string; closesAt: string } | null,
  appointments: DayLayout["blocks"][number]["appointment"][],
): string {
  return renderToStaticMarkup(
    <DayGrid layout={layoutFor(hours, appointments)} timezone={KOLKATA} now={null} />,
  );
}

describe("DayGrid", () => {
  it("renders each Appointment with its name, status and times", () => {
    const html = grid(NINE_TO_FIVE, [MORNING]);

    expect(html).toContain("Priya Sharma");
    expect(html).toContain("Confirmed");
    expect(html).toContain("09:00–09:45");
    expect(html).toContain("Cleaning");
  });

  it("positions a block by percentage, so it lines up with the hour labels", () => {
    // 11:30-12:00 in a 09:00-17:00 window: 31.25% down, 6.25% tall.
    const html = grid(NINE_TO_FIVE, [
      {
        ...MORNING,
        startsAt: new Date("2026-08-19T06:00:00.000Z"),
        endsAt: new Date("2026-08-19T06:30:00.000Z"),
      },
    ]);

    expect(html).toContain("top:31.25%");
    expect(html).toContain("height:6.25%");
  });

  it("keeps a short Appointment legible instead of clipping it to a sliver", () => {
    // 15 minutes is 16px at 64px an hour — less than one line of text once the
    // border and padding are taken off. `min-h-6` is the floor that stops the
    // block rendering as an unreadable strip.
    const html = grid(NINE_TO_FIVE, [
      {
        ...MORNING,
        name: "Quick Trim",
        startsAt: new Date("2026-08-19T06:00:00.000Z"),
        endsAt: new Date("2026-08-19T06:15:00.000Z"),
      },
    ]);

    expect(html).toContain("min-h-6");
    // The two facts that identify a booking, and the status word beside them,
    // share the one line that the floor guarantees.
    expect(html).toContain("Quick Trim");
    expect(html).toContain("Confirmed");
    expect(html).toContain("11:30–11:45");
  });

  it("is genuinely read-only — no control of any kind inside the grid", () => {
    const html = grid(NINE_TO_FIVE, [MORNING]);

    for (const control of ["<button", "<a ", "<input", "draggable", "onclick"]) {
      expect(html, control).not.toContain(control);
    }
  });

  it("still draws the day when nothing is booked, and says so", () => {
    const html = grid(NINE_TO_FIVE, []);

    // The shape of the day is the information, so the hour labels stay.
    expect(html).toContain("09:00");
    expect(html).toContain("17:00");
    expect(html).toContain("No appointments.");
  });

  it("marks a clash in amber, and marks nothing else", () => {
    const collided = grid(NINE_TO_FIVE, [
      { ...MORNING, needsAttentionReason: "collision" },
    ]);
    /*
      The block says where the fix is, not what the problem is called. The
      Schedule is read-only, so "Collision" on its own asked for a decision
      this screen gives nobody a way to act on.
    */
    expect(collided).toContain("Clashes in Google Calendar");
    expect(collided).toContain("border-attention");

    const failedToBook = grid(NINE_TO_FIVE, [
      { ...MORNING, needsAttentionReason: "book_failed" },
    ]);
    expect(failedToBook).not.toContain("Clashes in Google Calendar");
    expect(failedToBook).not.toContain("border-attention");
  });

  it("shades and labels an Appointment sitting outside opening hours", () => {
    // 08:00-08:45 Kolkata, an hour before the doors open.
    const html = grid(NINE_TO_FIVE, [
      {
        ...MORNING,
        startsAt: new Date("2026-08-19T02:30:00.000Z"),
        endsAt: new Date("2026-08-19T03:15:00.000Z"),
      },
    ]);

    expect(html).toContain("Outside hours");
    // The shaded band before opening: one hour of a nine-hour window.
    expect(html).toContain("top:0%;height:11.11");
  });

  it("shades the whole day when the Business is shut but a booking stands", () => {
    const html = grid(null, [MORNING]);
    expect(html).toContain("top:0%;height:100%");
    expect(html).toContain("Priya Sharma");
  });
});

describe("ClosedDay", () => {
  it("names the weekday rather than the date", () => {
    // 23 August 2026 is a Sunday.
    const html = renderToStaticMarkup(
      <ClosedDay date={{ year: 2026, month: 8, day: 23 }} />,
    );

    expect(html).toContain("Closed on Sundays.");
    expect(html).toContain("No appointments.");
  });
});

describe("DayNav", () => {
  it("links a day either side, and Today with no param at all", () => {
    const html = renderToStaticMarkup(
      <DayNav
        date={WEDNESDAY}
        timezone={KOLKATA}
        hours={layoutFor(NINE_TO_FIVE, []).hours}
        appointmentCount={0}
      isToday={false} />,
    );

    expect(html).toContain('href="/schedule?date=2026-08-18"');
    expect(html).toContain('href="/schedule?date=2026-08-20"');
    expect(html).toContain('href="/schedule"');
    // The date is the page's title now: spelled out, and without the year,
    // which nobody needed on a screen that only ever shows this week or next.
    expect(html).toContain("Wednesday 19 August");
    expect(html).toContain("Open <span class=\"font-mono\">09:00</span> to");
  });

  it("counts the bookings on a day the Business is shut", () => {
    const html = renderToStaticMarkup(
      <DayNav
        date={WEDNESDAY}
        timezone={KOLKATA}
        hours={null}
        appointmentCount={1}
      isToday={false} />,
    );

    expect(html).toContain("Closed · 1 appointment");
    expect(html).not.toContain("1 appointments");
  });

  it("says only Closed when there is nothing on the day", () => {
    const html = renderToStaticMarkup(
      <DayNav
        date={WEDNESDAY}
        timezone={KOLKATA}
        hours={null}
        appointmentCount={0}
      isToday={false} />,
    );

    expect(html).toContain("Closed");
    expect(html).not.toContain("appointment");
  });
});
