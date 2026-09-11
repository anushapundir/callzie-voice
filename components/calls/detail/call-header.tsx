import Link from "next/link"

import { CallStatusPill } from "@/components/calls/call-status-pill"
import type { CallDetail } from "@/lib/calls/detail"
import { formatDuration } from "@/lib/calls/duration"
import { formatInZone } from "@/lib/time/zone"

/**
 * Who this call was to, about what, and how it went.
 *
 * The masthead of a printed record: the name large in the serif, the status
 * beside it, then four facts on one hairline-bounded line. Nothing here is a
 * box. The rule above and below the facts is what groups them, which is the
 * whole idea in docs/design.md — a section is a run of rows separated by
 * hairlines, not a box.
 *
 * Times go through `formatInZone`, the one formatter in this app that renders an
 * instant in the business's own timezone. Three screens used to build their own
 * `Intl.DateTimeFormat` for the same appointment and printed it three different
 * ways; the timezone is a property of the business, not of whoever is reading,
 * and a reader on holiday must not see a different time.
 */
export function CallHeader({ detail }: { detail: CallDetail }) {
  /*
    Null on an inbound call that did not book (issue #43). The row that
    describes an appointment is replaced by the caller's number in that case
    rather than rendered with a dash — a time is not missing data on a call from
    a stranger, it is a question that does not apply.
  */
  const when = detail.appointmentStartsAt
    ? formatInZone(detail.appointmentStartsAt, detail.timezone)
    : null

  return (
    <header className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {/*
          `h2`, not `h1`. components/app-shell/topbar.tsx already renders the
          page's `<h1>` ("Calls") from the pathname, and two `<h1>` elements on
          one page leave a screen reader with no single answer to "what is this
          page".
        */}
        <h2 className="min-w-0 font-serif text-title text-text">
          {detail.personName}
        </h2>
        <CallStatusPill status={detail.status} />
        {/*
          Says which way the call went, as a plain word rather than a bordered
          chip — a chip next to the status pill reads as a second status. Only
          on inbound: outbound is what this product does by default, and
          labelling every call "Outgoing" is noise that makes the one word that
          matters harder to notice.
        */}
        {detail.direction === "inbound" ? (
          <span className="text-table text-text-muted">Incoming</span>
        ) : null}
      </div>

      <dl className="flex flex-wrap items-center gap-x-8 gap-y-2 border-y border-line py-3 text-table text-text-muted">
        <Fact label="Service">{detail.serviceName ?? "—"}</Fact>
        {when ? (
          <Fact label="Appointment" mono>
            {when}
          </Fact>
        ) : (
          <Fact label="From" mono>
            {detail.phoneE164}
          </Fact>
        )}
        <Fact label="Duration" mono>
          {formatDuration(detail.durationSeconds)}
        </Fact>
        <Fact label="Attempt">
          {detail.attempt} of {detail.attemptCount}
        </Fact>
      </dl>

      {/*
        A retry creates a second call rather than reviving this one, so an
        appointment that has been tried twice has two readable records. This is
        the way between them.
      */}
      {detail.attemptCount > 1 ? (
        <p className="text-table text-text-muted">
          {/*
            How an inline text link is drawn, here and on the rest of this
            screen. The underline is always there, faintly.

            Links in this app are the same ink as the words around them — that
            is deliberate, colour is reserved for a live call — which left them
            invisible: a sentence with a link in it looked exactly like a
            sentence without one. A hairline underline that darkens to full ink
            on hover is the "rule draw" motion in docs/design.md, and it makes
            the link findable without spending the one colour on it.
          */}
          <Link
            className="text-text underline decoration-line-strong decoration-1 underline-offset-4 transition-colors hover:decoration-text"
            href="/calls"
          >
            See the other attempts for {detail.personName}
          </Link>
        </p>
      ) : null}
    </header>
  )
}

/** One fact of the masthead: its label in muted, its value in ink. */
function Fact({
  label,
  mono = false,
  children,
}: {
  label: string
  /** Clock times, durations and phone numbers only — the mono face's job. */
  mono?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2">
      <dt>{label}</dt>
      <dd className={mono ? "font-mono text-text" : "text-text"}>{children}</dd>
    </div>
  )
}
