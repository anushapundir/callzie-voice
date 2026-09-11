import Link from "next/link"

import { CallNowButton } from "@/components/calls/call-now-button"
import { StatusPill } from "@/components/overview/status-pill"
import { PageHeader } from "@/components/ui/page-header"
import type { AppointmentRow } from "@/lib/business/list-appointments"
import { formatInZone } from "@/lib/time/zone"
import { cn } from "@/lib/utils"

/**
 * The Appointments a Business has (SPEC.md §11.3): Name · Phone · Service ·
 * Time · Status · Attempts · Last call.
 *
 * Still a **server** component: every time here is formatted in the Business's
 * own timezone, and doing that on the server means one `Intl` pass and no chance
 * of a hydration mismatch between the viewer's clock and the Business's. The
 * only client island is the "Call now" button on each row.
 *
 * **Not a card.** A run of rows separated by hairlines is a section, and a
 * section does not get a box (docs/design.md). The one heavier rule under the
 * heading is what says a new part of the page starts here.
 *
 * **The timezone is in the column header, not in a sentence.** It used to be
 * printed twice on this screen as prose — once here and once on the Quick call
 * card — which is two lines of type spent on a fact that belongs above the
 * column it applies to.
 *
 * The shimmer comes from `isCalling`, decided in `lib/business/list-appointments.ts`
 * so this file has nothing to work out — "live" is `in_progress` AND recent, and
 * that rule belongs in one place.
 *
 * The Needs Attention panel is its own surface above this one; what reaches the
 * table from it is `blocked` on each row's Call now button.
 */

type AppointmentsTableProps = {
  appointments: AppointmentRow[]
  /** The Business's IANA zone — times mean nothing without it. */
  timezone: string
  /**
   * How many Appointments are in the window this page of rows came from, so the
   * heading can say "20 of 47" instead of silently hiding twenty-seven people.
   */
  total: number
  /**
   * Actions for the heading row — Upload CSV and Call all.
   *
   * A slot rather than the buttons themselves, because this is a Server
   * Component and both of those are client ones. Taking them as a node means the
   * table never has to know that, and never has to grow a `"use client"` of its
   * own.
   */
  toolbar?: React.ReactNode
}

export function AppointmentsTable({
  appointments,
  timezone,
  total,
  toolbar,
}: AppointmentsTableProps) {
  return (
    <section className="workspace-table flex flex-col">
      <PageHeader
        title="Appointments"
        description={
          total > appointments.length
            ? `Showing ${appointments.length} of ${total}`
            : undefined
        }
        actions={toolbar}
      />

      {/*
        `overflow-x-auto`, not `overflow-hidden`.

        Eight columns do not fit a narrow desktop window, and `overflow-hidden`
        clips the overflow with no way to reach it — the "Call now" button at the
        end of each row was cut in half and partly unclickable. Scrolling the
        table inside its own strip keeps every column reachable without the page
        body itself scrolling sideways.
      */}
      <div className="overflow-x-auto">
        {/* Table above `md`, stacked rows below it (§11.4's 375px floor). */}
        <table className="hidden w-full text-table md:table">
          <thead>
            <tr className="border-b border-line text-left">
              <Th>Name</Th>
              <Th>Phone</Th>
              <Th>Service</Th>
              <Th>Time ({timezone})</Th>
              <Th>Status</Th>
              <Th>Attempts</Th>
              <Th>Last call</Th>
              <Th>
                {/* The buttons name themselves; a visible header would just
                    repeat them seven times. */}
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {appointments.map((appointment) => (
              <tr
                key={appointment.id}
                className={cn(
                  "h-11 border-b border-line hover:bg-surface-soft",
                  appointment.isCalling && "animate-row-shimmer",
                )}
              >
                <Td className="text-text">
                  <span className="font-medium">{appointment.name}</span>
                  <ExampleTag isExample={appointment.isExample} />
                </Td>
                <Td className="font-mono">{appointment.phoneE164}</Td>
                <Td>{appointment.serviceName}</Td>
                <Td className="font-mono whitespace-nowrap">
                  {formatInZone(appointment.startsAt, timezone)}
                </Td>
                <Td>
                  <StatusPill status={appointment.status} quiet />
                </Td>
                {/* Inter, not mono: a count is a figure, and mono's slashed
                    zero makes "0" read as an error. */}
                <Td>
                  <Attempts count={appointment.attempts} />
                </Td>
                <Td>
                  <LastCall
                    lastCallId={appointment.lastCallId}
                    lastCallAt={appointment.lastCallAt}
                    timezone={timezone}
                  />
                </Td>
                <Td className="text-right">
                  <BlockedNote
                    blocked={appointment.needsAttentionReason !== null}
                  />
                  <CallNowButton
                    appointmentId={appointment.id}
                    name={appointment.name}
                    blocked={appointment.needsAttentionReason !== null}
                  />
                </Td>
              </tr>
            ))}
            {appointments.length === 0 && (
              <tr>
                <Td className="text-text-muted" colSpan={8}>
                  Nothing coming up. Add somebody with Quick call above.
                </Td>
              </tr>
            )}
          </tbody>
        </table>

        <ul className="md:hidden">
          {appointments.map((appointment) => (
            <li
              key={appointment.id}
              className={cn(
                "flex flex-col gap-2 border-b border-line py-4",
                appointment.isCalling && "animate-row-shimmer",
              )}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-body font-medium text-text">
                  {appointment.name}
                  <ExampleTag isExample={appointment.isExample} />
                </span>
                <StatusPill status={appointment.status} quiet />
              </div>
              <span className="font-mono text-table text-text-muted">
                {appointment.phoneE164}
              </span>
              <div className="flex items-baseline justify-between gap-3 text-table text-text-muted">
                <span>{appointment.serviceName}</span>
                <span className="font-mono">
                  {formatInZone(appointment.startsAt, timezone)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3 text-table text-text-muted">
                <span>
                  Attempts <Attempts count={appointment.attempts} />
                </span>
                <LastCall
                  lastCallId={appointment.lastCallId}
                  lastCallAt={appointment.lastCallAt}
                  timezone={timezone}
                />
              </div>
              <div className="pt-1">
                <BlockedNote
                  blocked={appointment.needsAttentionReason !== null}
                />
                <CallNowButton
                  appointmentId={appointment.id}
                  name={appointment.name}
                  blocked={appointment.needsAttentionReason !== null}
                />
              </div>
            </li>
          ))}
          {appointments.length === 0 && (
            <li className="py-4 text-table text-text-muted">
              Nothing coming up. Add somebody with Quick call above.
            </li>
          )}
        </ul>
      </div>
    </section>
  )
}

/*
  There structurally cannot be an empty list on a new account — onboarding seeds
  Appointments in the same transaction as the Business — so the empty rows above
  are for the account that has worked through everything, and for the case where
  the seed itself failed. Either way the screen says something rather than
  rendering an unexplained blank.
*/

/**
 * "Example" beside a seeded name.
 *
 * The five rows an account starts with are believable people with believable
 * phone numbers, which is what makes the demo work and also what makes them
 * indistinguishable from real customers. Somebody who has just signed up should
 * be able to tell at a glance which rows they put there themselves.
 *
 * Muted and small, because it is a footnote on the row, not a status.
 */
function ExampleTag({ isExample }: { isExample: boolean }) {
  if (!isExample) return null

  return (
    <span className="ml-2 text-table font-normal text-text-muted">Example</span>
  )
}

/**
 * Why this row's "Call now" is dead, for anyone who cannot hover it.
 *
 * `CallNowButton` explains itself with a `title`, and a `title` reaches almost
 * nobody who needs it here. A disabled button is out of the tab order, so a
 * keyboard user never lands on it; a screen reader browsing the row is not
 * reliably given the attribute either; and tooltips do not fire on a tap, which
 * is the stacked layout below `md` — the mobile one. Sighted mouse users are
 * the only group the `title` actually serves.
 *
 * So the reason is said in text as well. Not visible text: the row already
 * shows a status and the panel above the table gives the full sentence and the
 * Clear button, so a second visible marker here would be noise for people who
 * can see both.
 *
 * It points at the panel rather than repeating the reason, because the panel is
 * where the Clear button is. Telling somebody what is wrong without telling
 * them where to fix it is half an answer.
 */
function BlockedNote({ blocked }: { blocked: boolean }) {
  if (!blocked) return null

  return (
    <span className="sr-only">
      Needs attention. Clear it in the panel above this table to call again.
    </span>
  )
}

/** "—" rather than "0", which reads as an attempt that failed. */
function Attempts({ count }: { count: number }) {
  return <span>{count === 0 ? "—" : count}</span>
}

/**
 * When the last Call was placed, linking to the Call itself.
 *
 * A link now, not plain text: `/calls/[id]` exists, and the row already carries
 * the id it needs. The id is never rendered — it means nothing to anyone reading
 * the screen — so the timestamp is the link text.
 *
 * The timestamp, not the attempt number. The column beside this one already
 * says how many attempts there were, and a column that repeats its neighbour is
 * a column doing no work.
 */
function LastCall({
  lastCallId,
  lastCallAt,
  timezone,
}: {
  lastCallId: string | null
  lastCallAt: Date | null
  timezone: string
}) {
  if (!lastCallAt || !lastCallId) {
    return <span className="font-mono text-text-muted">—</span>
  }

  return (
    /*
      Ink with a rule drawn on hover, never a coloured link — cobalt in this
      design means one thing only, and it is not "you can click this".
    */
    <Link
      href={`/calls/${lastCallId}`}
      className="font-mono whitespace-nowrap text-text underline-offset-4 hover:underline"
    >
      {formatInZone(lastCallAt, timezone)}
    </Link>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  // `scope="col"` so a screen reader announces the column name with each cell
  // rather than guessing at an eight-column table.
  return (
    <th
      scope="col"
      className="px-4 py-2 text-table font-medium tracking-[0.06em] text-text-muted uppercase first:pl-0 last:pr-0"
    >
      {children}
    </th>
  )
}

/*
  `cn` rather than a template string, and this is not a style preference.

  Every cell is muted by default and the Name column passes `text-text` to lift
  it. Concatenated, both land on the same element at equal specificity, so the
  winner is whichever rule the stylesheet happens to emit last — which was
  `text-text-muted`, silently flattening the column the eye is supposed to go
  to first.

  `app/globals.css` makes an *off*-token class emit nothing, which is the
  protection this design leans on. It does nothing about a *conflicting*
  on-token class. `cn` is tailwind-merge, which resolves that by argument
  order, so the caller's class wins because it comes last.

  `first:pl-0` and `last:pr-0` pull the outer cells flush with the page gutter,
  which is what makes a table with no box around it still line up with the
  figures above it.
*/
function Td({
  children,
  className,
  colSpan,
}: {
  children: React.ReactNode
  className?: string
  colSpan?: number
}) {
  return (
    <td
      colSpan={colSpan}
      className={cn(
        "px-4 py-2 text-text-muted first:pl-0 last:pr-0",
        className,
      )}
    >
      {children}
    </td>
  )
}
