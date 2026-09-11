import { AppointmentBlock } from "@/components/schedule/appointment-block"
import type { DayLayout } from "@/lib/schedule/day-layout"
import { cn } from "@/lib/utils"

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
 * **Three line weights, and they mean different things.** The frame around the
 * grid and the divider beside the hour numbers are full `line`, because they are
 * the structure. The hour rulings inside are `line/50`, because they are a
 * measure you read against, not an edge. When all three were the same weight
 * nothing read as structure and the grid looked like graph paper.
 *
 * **What is not drawn: free Slots.** Gaps are gaps. A Slot's size is a Service's
 * duration and a Business holds several, so any free-Slot band would be right
 * for one Service and wrong for the rest.
 */

/**
 * One hour of the day, in pixels. Enough that a 15-minute Appointment still gets
 * a readable 16px block, and that eight opening hours fit a laptop screen.
 */
const PIXELS_PER_HOUR = 64

/**
 * The shop is shut: diagonal hairlines, the same colour as every other rule on
 * the page.
 *
 * A flat wash was tried first and it does not work — a grey light enough not to
 * fight the hour numbers is too light to notice at all, so the band read as a
 * rendering glitch rather than as closed time. A hatch is unmistakably drawn on
 * purpose, and it survives being printed.
 *
 * `var(--color-line)` rather than a Tailwind class because this is a gradient,
 * and Tailwind has no utility for one. It is still the token, so the dark ground
 * re-themes it with everything else.
 */
const CLOSED_HATCH = {
  backgroundImage:
    "repeating-linear-gradient(45deg, transparent 0 5px, var(--color-line) 5px 6px)",
}

type DayGridProps = {
  layout: DayLayout
  /** The Business's IANA zone — times mean nothing without it. */
  timezone: string
  /**
   * The current instant, but **only** when the day on screen is today in the
   * Business's zone — otherwise `null`. The page decides that, because the page
   * is what knows which day it asked for. Drawing a "now" line on last Tuesday
   * would be a lie.
   */
  now: Date | null
}

export function DayGrid({ layout, timezone, now }: DayGridProps) {
  const height = Math.round((layout.windowMinutes / 60) * PIXELS_PER_HOUR)
  const nowPercent = nowLineAt(layout, now)

  return (
    <section className="workspace-schedule-grid overflow-hidden border border-line">
      <div className="flex" style={{ height: `${height}px` }}>
        {/*
          The hour gutter, hidden from screen readers: every block already
          carries its own start and end in text, so reading a column of bare
          numbers first would only get in the way.
        */}
        <div className="relative w-14 shrink-0 border-r border-line" aria-hidden>
          {layout.gridlines.map((line, index) => (
            <span
              key={index}
              className={cn(
                "absolute right-2 font-mono text-table text-text-muted",
                /*
                  The closing hour sits on the frame's bottom edge, so a label
                  hung below it is cut in half by the frame. Pulling the last one
                  up by its own height puts it inside, where it can be read.
                */
                line.topPercent >= 100 && "-translate-y-full",
              )}
              style={{ top: `${line.topPercent}%` }}
            >
              {line.label}
            </span>
          ))}

          {nowPercent !== null && (
            <span
              className="absolute right-0 size-1.5 -translate-y-1/2 translate-x-1/2 rounded-full bg-text"
              style={{ top: `${nowPercent}%` }}
            />
          )}
        </div>

        <div className="relative flex-1">
          {/* Shading first, so the lines and blocks sit on top of it. */}
          {layout.outsideHours.map((band, index) => (
            <div
              key={index}
              className="absolute inset-x-0"
              style={{
                top: `${band.topPercent}%`,
                height: `${band.heightPercent}%`,
                ...CLOSED_HATCH,
              }}
              aria-hidden
            />
          ))}

          {/*
            The first and last rulings land exactly on the frame, which drew
            them as double lines. The frame is already the line at those two
            positions, so skip them.
          */}
          {layout.gridlines.map((line, index) =>
            line.topPercent <= 0 || line.topPercent >= 100 ? null : (
              <div
                key={index}
                className="absolute inset-x-0 border-t border-line/50"
                style={{ top: `${line.topPercent}%` }}
                aria-hidden
              />
            ),
          )}

          {layout.blocks.map((block) => (
            <AppointmentBlock
              key={block.appointment.id}
              block={block}
              timezone={timezone}
            />
          ))}

          {/*
            Where we are in the day. One ink hairline, drawn over the blocks so
            it is never hidden behind one — the first thing anyone looks for on a
            day view, and until now the one thing this screen did not say.
          */}
          {nowPercent !== null && (
            <div
              className="absolute inset-x-0 border-t border-text"
              style={{ top: `${nowPercent}%` }}
              aria-hidden
            />
          )}
        </div>
      </div>

      {/*
        An open day with nothing booked still draws its grid. The shape of the
        day is the information; hiding it would say less than showing it empty.
      */}
      {layout.blocks.length === 0 && (
        <p className="border-t border-line px-4 py-3 text-table text-text-muted">
          No appointments.
        </p>
      )}
    </section>
  )
}

/**
 * How far down the column "now" falls, as a percentage — or `null` when there
 * is no line to draw.
 *
 * Two ways it comes back null. The page passed `null` because the day on screen
 * is not today. Or it is today, but right now is outside the drawn window: at
 * 07:00 on a day that opens at 09:00 there is nothing on the grid to point at
 * yet, and a line pinned to the top edge would wrongly say the day has started.
 */
function nowLineAt(layout: DayLayout, now: Date | null): number | null {
  if (!now) return null

  const start = layout.windowStart.getTime()
  const total = layout.windowEnd.getTime() - start
  const percent = ((now.getTime() - start) / total) * 100
  return percent < 0 || percent > 100 ? null : percent
}
