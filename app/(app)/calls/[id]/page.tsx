import { notFound } from "next/navigation"

import { CallDetailPoller } from "@/components/calls/detail/call-detail-poller"
import { CallHeader } from "@/components/calls/detail/call-header"
import { EnquiryCard } from "@/components/calls/detail/enquiry-card"
import { ExtractionCard } from "@/components/calls/detail/extraction-card"
import { FailureCard } from "@/components/calls/detail/failure-card"
import { OutcomeCard } from "@/components/calls/detail/outcome-card"
import { RecordingPlayer } from "@/components/calls/detail/recording-player"
import { RetryCallButton } from "@/components/calls/detail/retry-call-button"
import { TranscriptPanel } from "@/components/calls/detail/transcript-panel"
import { EmptyState } from "@/components/ui/empty-state"
import { requireBusiness } from "@/lib/business/require-business"
import { loadCallDetail } from "@/lib/calls/detail"
import { noToolsSummary } from "@/lib/calls/no-tools"
import { callVerdict } from "@/lib/calls/outcome"
import { hasOutstandingData } from "@/lib/calls/outstanding"
import { formatInZone } from "@/lib/time/zone"

/**
 * The proof screen (SPEC.md §11.3, issue #16).
 *
 * It reads like a printed record: the verdict first, then the evidence. The name
 * and the four facts at the top, one sentence saying how it went, and below that
 * two columns — what you can hear and read on the left, what Maya actually did
 * on the right.
 *
 * A Server Component. Everything it renders comes from one `loadCallDetail`
 * call, and the two client components below it — the player and the poller —
 * are leaves rather than wrappers, so nothing here ships to the browser that
 * does not have to.
 *
 * `notFound()` rather than a 403 on a call this business does not own. The id
 * arrives from the URL and Callzie is open signup, so a 403 would confirm the id
 * exists. `loadCallDetail` cannot tell "no such call" from "somebody else's
 * call", which is the point.
 */
export default async function CallDetailPage({ params }: PageProps<"/calls/[id]">) {
  const { business } = await requireBusiness()
  const { id } = await params

  const detail = await loadCallDetail(business.id, id)
  if (!detail) notFound()

  const connected = detail.status !== "failed" && detail.status !== "no_answer"

  const outstanding = hasOutstandingData({
    status: detail.status,
    hasTranscript: detail.hasTranscript,
    hasRecording: detail.recordingUrl !== null,
    hasExtraction: detail.extraction !== null,
  })

  /*
    The booked time, in the business's own timezone.

    Preferring the appointment's own `startsAt` over the words Maya said is not
    fussiness: a successful booking moves the appointment, so that column is the
    time that is actually in the diary, and it is the one the rest of the app
    shows. The spoken form is the fallback for an inbound call, which books a
    brand-new appointment this screen may not have loaded a row for.
  */
  const bookedTime = detail.outcome.bookedTime
    ? detail.appointmentStartsAt
      ? formatInZone(detail.appointmentStartsAt, detail.timezone)
      : detail.outcome.bookedTime
    : null

  const verdict = callVerdict({
    connected,
    bookedTime,
    personName: detail.personName,
  })

  return (
    <div className="flex flex-col gap-6">
      {outstanding ? <CallDetailPoller /> : null}

      <CallHeader detail={detail} />

      {/*
        The single most important line on the screen, and the reason it spans
        both columns rather than living in a card: the first question anybody
        opening this page has is "did it get booked", and the answer used to be
        somewhere in the middle of the right-hand column.
      */}
      <p className="workspace-call-verdict font-serif text-[22px] leading-7 text-text">{verdict}</p>

      {/* Two columns above `lg`, stacked below — SPEC.md §11.4's 375px floor. */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-6">
          {connected ? (
            <>
              <RecordingPlayer
                recordingUrl={detail.recordingUrl}
                durationSeconds={detail.durationSeconds}
              />
              <TranscriptPanel
                turns={detail.turns}
                personName={detail.personName}
              />
            </>
          ) : (
            /*
              One quiet line, not two spinners.

              A call that never connected has no recording and no transcript, and
              neither is ever coming. Rendering the two waiting panels anyway
              left two spinners turning forever on a page whose whole message is
              that nothing happened — which reads as a product still loading
              rather than as a call that did not connect.
            */
            <EmptyState title="Nothing to listen to">
              This call never became a conversation, so there is no recording and
              no transcript. The card on the right says why.
            </EmptyState>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          {/*
            First in this column on purpose. On a call that never connected this
            is the only card with anything to say, and everything below it is
            empty for the reason it is explaining.
          */}
          {!connected ? (
            <FailureCard
              disconnectReason={detail.disconnectReason}
              /*
                No retry on an inbound call, and not because the button would
                crash without an appointment id. Retry means "ring this person
                again about their appointment", and somebody who rang Callzie
                has neither. What they have is an enquiry, which is the card
                below and the thing a human actually acts on.
              */
              retry={
                detail.appointmentId ? (
                  <RetryCallButton
                    appointmentId={detail.appointmentId}
                    personName={detail.personName}
                  />
                ) : null
              }
            />
          ) : null}

          <EnquiryCard enquiry={detail.enquiry} timezone={detail.timezone} />

          <OutcomeCard
            outcome={detail.outcome}
            verdict={verdict}
            noTools={noToolsSummary({
              callStatus: detail.status,
              personName: detail.personName,
              extraction: detail.extraction,
            })}
          />

          {/*
            The third spinner that never stopped. A write-up is produced from a
            transcript, so a call with no conversation will never get one — and
            the waiting panel would sit there spinning about it forever.
          */}
          {connected || detail.extraction !== null ? (
            <ExtractionCard extraction={detail.extraction} />
          ) : null}
        </div>
      </div>
    </div>
  )
}
