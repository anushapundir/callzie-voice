import Link from "next/link"

import { AttentionPanel } from "@/components/overview/attention-panel"
import { ResolveEnquiryButton } from "@/components/overview/resolve-enquiry-button"
import type { OpenEnquiryRow } from "@/lib/business/open-enquiries"
import type { EnquiryKind } from "@/lib/db/schema"

/**
 * People who rang and are waiting to hear back (issue #43).
 *
 * The inbound sibling of `needs-attention.tsx`, and it follows every rule that
 * one sets out: inline and persistent rather than a toast, no Dismiss, nothing
 * that auto-resolves, and the shared panel shape from `attention-panel.tsx`.
 * Read that file's header for the reasoning — all of it applies here unchanged.
 *
 * A separate panel rather than extra rows in that one, because the two say
 * different things and the difference matters to whoever is reading. A Needs
 * Attention row is an Appointment **Callzie has stopped calling**; a row here is
 * a person **waiting for the business to call them**. Merging them would produce
 * one list where "clear this" means two different things.
 *
 * It sits directly above Needs Attention on the page. Somebody who rang last
 * night and was promised a callback is the more time-sensitive of the two, and
 * they are the only one of the two who is actively waiting on a human.
 */

/** What each kind is called, in the words somebody at a front desk would use. */
const KINDS: Record<EnquiryKind, string> = {
  booked: "Booked",
  question: "Question",
  complaint: "Complaint",
  callback: "Wants a call back",
  refused: "Maya could not help",
}

export function OpenEnquiries({ rows }: { rows: OpenEnquiryRow[] }) {
  // No section at all when there is nothing, matching Needs Attention — a
  // healthy account's Overview carries no heading about problems it does not
  // have.
  if (rows.length === 0) return null

  return (
    <AttentionPanel
      id="open-enquiries"
      heading={
        <>
          {/* Amber on the number only — the sentence stays ink. */}
          <span className="text-attention">{rows.length}</span>{" "}
          {rows.length === 1
            ? "caller is waiting to hear back"
            : "callers are waiting to hear back"}
        </>
      }
    >
      <p className="text-table text-text-muted">
        Maya answered these and could not finish them herself.
      </p>

      <ul className="mt-3 flex flex-col gap-3">
        {rows.map((row) => (
          <li
            key={row.id}
            className="flex flex-col gap-1 border-t border-line pt-3 first:border-t-0 first:pt-0"
          >
            <div className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
              <p className="text-table text-text">
                {row.callerName ?? "Caller"}
                {row.callerPhoneE164 ? (
                  <>
                    <span aria-hidden className="px-1 text-text-muted">
                      ·
                    </span>
                    {/* Mono — phone numbers belong with slot times. */}
                    <span className="font-mono whitespace-nowrap text-text-muted">
                      {row.callerPhoneE164}
                    </span>
                  </>
                ) : null}
                <span aria-hidden className="px-1 text-text-muted">
                  ·
                </span>
                <span className="text-text-muted">{KINDS[row.kind]}</span>
              </p>

              <ResolveEnquiryButton
                enquiryId={row.id}
                name={row.callerName ?? row.callerPhoneE164 ?? "this caller"}
              />
            </div>

            {/*
              What they actually said, in Maya's words. This is the row's whole
              value — a list of "callback requested" with no topic is a list of
              phone calls somebody has to make blind.
            */}
            {row.topic ? (
              <p className="text-table text-text-muted">{row.topic}</p>
            ) : null}

            <p className="text-table">
              {/* Ink with a rule drawn on hover. A coloured link would spend the
                  one colour this design reserves for a live call. */}
              <Link
                className="text-text underline-offset-4 hover:underline"
                href={`/calls/${row.callId}`}
              >
                Listen to the call
              </Link>
            </p>
          </li>
        ))}
      </ul>
    </AttentionPanel>
  )
}
