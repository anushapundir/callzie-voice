import type { CallEnquiry } from "@/lib/calls/detail"
import type { EnquiryKind } from "@/lib/db/schema"

/**
 * What an inbound Call turned out to be (issue #43).
 *
 * Sits above the Outcome card, because on an inbound Call this is the answer to
 * "what happened" and the Tool invocations below are the evidence for it. On an
 * outbound Call it renders nothing at all — there is no Enquiry, and an empty
 * card explaining that would be noise on every existing screen.
 *
 * Written by a Tool during the Call, not by the extraction pass afterwards, so
 * it is there whether or not the LLM ever returned valid JSON (SPEC.md §9 step
 * 3). A complaint cannot vanish because an extraction failed.
 */

/** What each kind is called on screen, and what colour it carries. */
const KINDS: Record<EnquiryKind, { label: string; tone: string }> = {
  booked: { label: "Booked", tone: "text-confirmed" },
  question: { label: "Question answered", tone: "text-text-muted" },
  complaint: { label: "Complaint", tone: "text-declined" },
  callback: { label: "Callback requested", tone: "text-attention" },
  /*
    Amber rather than red. A refusal is Maya working correctly — SPEC.md §14
    rules 10 to 13 — and colouring it as a failure would train somebody to
    scroll past the one kind of call most likely to need a person.
  */
  refused: { label: "Declined to help", tone: "text-attention" },
}

export function EnquiryCard({
  enquiry,
}: {
  enquiry: CallEnquiry | null
  /** Unused today; kept so a future "logged at" line needs no plumbing. */
  timezone: string
}) {
  if (!enquiry) return null

  const kind = KINDS[enquiry.kind]

  return (
    /*
      A section, not a box. It sits between the ink outcome card and the
      write-up, and a third bordered rectangle in that stack made the column read
      as a pile of tiles. A heading over the one heavier rule in the system is
      what says "a new part of the page starts here" (docs/design.md).
    */
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line-strong pb-2">
        <h3 className="text-section text-text">Enquiry</h3>
        <span className={`text-table ${kind.tone}`}>{kind.label}</span>
      </div>

      {enquiry.topic ? (
        <p className="mt-3 max-w-prose text-body text-text">{enquiry.topic}</p>
      ) : null}

      <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2 text-table text-text-muted">
        {enquiry.callerName ? (
          <div className="flex items-center gap-2">
            <dt>Name</dt>
            <dd className="text-text">{enquiry.callerName}</dd>
          </div>
        ) : null}
        {enquiry.callerPhoneE164 ? (
          <div className="flex items-center gap-2">
            <dt>Call back on</dt>
            <dd className="font-mono text-text">{enquiry.callerPhoneE164}</dd>
          </div>
        ) : null}
      </dl>

      {/*
        The line that makes this section worth reading. Callzie never resolves an
        enquiry itself (CONTEXT.md), so an unresolved one is a job somebody at
        the business still has to do — and saying so here is what stops it
        looking like a record of something already handled.
      */}
      {!enquiry.resolved ? (
        <p className="mt-3 border-t border-line pt-3 text-table text-attention">
          Waiting for someone at the business to follow this up.
        </p>
      ) : null}
    </section>
  )
}
