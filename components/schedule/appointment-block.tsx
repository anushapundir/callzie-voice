import { StatusPill } from "@/components/overview/status-pill"
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
 * inline styles — the one place this app cannot use a token. A Tailwind class is
 * a fixed string in source, and every block has a different top.
 *
 * **A block is a fill and one rule, not a box.** Soft paper behind it, a 2px ink
 * rule down its left edge, and no border at all. The one exception is a
 * Collision, which is the only bordered block on the grid — that is what makes
 * it findable in a column of twenty.
 *
 * A block clips rather than grows, because letting one push its neighbours down
 * would put the whole column out of step with the hour labels beside it. Which
 * makes the order of the two lines a real decision:
 *
 * - **Line one is who** — the customer's name and the status. At 64px an hour a
 *   15-minute Appointment is 16px tall, so `min-h-6` is what guarantees this
 *   line is always fully legible rather than clipped to a sliver. A short block
 *   then overhangs the next few minutes by a few pixels, which is the right
 *   trade: an unreadable block is worth nothing.
 * - **Line two is when and what** — the times and the Service. It is the first
 *   thing to be clipped, and the name above it still identifies the booking.
 *
 * Before this the name, the status, the times and the Service were crammed onto
 * one 24px line, and `truncate` ate the customer's name first — the one thing
 * you actually read the row for.
 *
 * Status is a colour **and** a word, never colour alone — the reason
 * `lib/appointments/status-style.ts` gives. `StatusPill` is the shared way to
 * draw that pair, so a Call in progress here gets the same dot it gets on the
 * Overview.
 */

/**
 * A Collision's fill: the same diagonal hatch the closed-hours bands use, in
 * amber and faint enough to read text through. A printer's hatch says "this one
 * is not like the others" without needing a second colour anywhere else.
 */
const COLLISION_HATCH = {
  backgroundImage:
    "repeating-linear-gradient(45deg, transparent 0 5px, color-mix(in oklab, var(--color-attention) 22%, transparent) 5px 6px)",
}

type AppointmentBlockProps = {
  block: DayBlock
  /** The Business's IANA zone — times mean nothing without it. */
  timezone: string
}

export function AppointmentBlock({ block, timezone }: AppointmentBlockProps) {
  const { appointment } = block

  return (
    <article
      className={cn(
        "absolute flex min-h-6 gap-2 overflow-hidden rounded-control bg-surface-soft pr-2",
        block.collision && "border border-attention",
      )}
      style={{
        top: `${block.topPercent}%`,
        height: `${block.heightPercent}%`,
        /*
          Two bookings at the same time split the column between them rather
          than stacking on top of each other — `lane` is which half, `laneCount`
          how many halves. The 4px and 8px keep the old gap either side: at one
          lane this is exactly the full width less a 4px margin each side.
        */
        left: `calc(${(block.lane / block.laneCount) * 100}% + 4px)`,
        width: `calc(${100 / block.laneCount}% - 8px)`,
        ...(block.collision ? COLLISION_HATCH : null),
      }}
    >
      {/* The 2px ink rule. Full height because the block's height is the
          duration, and the rule is what measures it. */}
      <span className="w-0.5 shrink-0 bg-text" aria-hidden />

      <div className="min-w-0 flex-1 py-0.5">
        <p className="flex items-center gap-2 text-table">
          <span className="truncate font-medium text-text">
            {appointment.name}
          </span>
          <StatusPill status={appointment.status} quiet />
        </p>

        {/*
          The extras. Everything here can be clipped away on a short block
          without the booking becoming unidentifiable.
        */}
        <p
          className={cn(
            "truncate text-table",
            block.collision ? "text-attention" : "text-text-muted",
          )}
        >
          <span className="font-mono">
            {`${clockInZone(appointment.startsAt, timezone)}–${clockInZone(
              appointment.endsAt,
              timezone,
            )}`}
          </span>{" "}
          · {appointment.serviceName}
          {/*
            The old copy said only "Collision", which asks the reader to decide
            something this screen gives them no way to act on — the Schedule is
            read-only and the clash lives in the calendar, not here. So say where
            to go and fix it.
          */}
          {block.collision && <span> · Clashes in Google Calendar, fix it there</span>}
          {!block.collision && block.outsideHours && (
            <span> · Outside hours</span>
          )}
        </p>
      </div>
    </article>
  )
}
