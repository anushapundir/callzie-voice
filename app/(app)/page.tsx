import Image from "next/image"
import { slotOptionsAction } from "@/app/(app)/actions"
import { AppointmentsTable } from "@/components/overview/appointments-table"
import { BatchStrip } from "@/components/overview/batch-strip"
import { CallAlert } from "@/components/overview/call-alerts"
import { CollisionCheck } from "@/components/overview/collision-check"
import { CallAllButton } from "@/components/overview/call-all-button"
import { CsvRejections } from "@/components/overview/csv-rejections"
import {
  CsvUploadProvider,
  UploadCsvButton,
} from "@/components/overview/csv-upload"
import { LiveCallsStrip } from "@/components/overview/live-calls-strip"
import { NeedsAttention } from "@/components/overview/needs-attention"
import { OpenEnquiries } from "@/components/overview/open-enquiries"
import { QuickCallCard } from "@/components/overview/quick-call-card"
import { StatStrip } from "@/components/overview/stat-strip"
import { listLiveCalls } from "@/lib/business/active-calls"
import { appointmentStats } from "@/lib/business/appointment-stats"
import { loadCallAlert } from "@/lib/business/call-alerts"
import { listUpcomingAppointments } from "@/lib/business/list-appointments"
import { listNeedsAttention } from "@/lib/business/needs-attention"
import { listOpenEnquiries } from "@/lib/business/open-enquiries"
import { listServices } from "@/lib/business/list-services"
import { requireBusiness } from "@/lib/business/require-business"
import { batchProgress } from "@/lib/calls/batch/queue"

/**
 * Overview — the demo stage (SPEC.md §11.3), and the screen onboarding lands
 * on with its Template's seeded Appointments already in it.
 *
 * `requireBusiness()` is React-`cache()`d and the shell layout above has
 * already called it, so it costs no second query.
 *
 * Every item in §11.3 is now on this screen. Call all arrived with #17 and
 * brought the ~5s revalidation with it — the strip's tick is what refreshes
 * these rows while a batch of Phone Calls is in flight, which
 * `live-call-provider.tsx` cannot do because it only runs while this browser
 * owns a Web Call. The Needs Attention section arrived with #15.
 *
 * `CsvUploadProvider` wraps the lot because #8's two halves sit apart: the
 * Upload CSV button lives in the table's heading row, and the report it produces
 * renders above the Quick call card. Everything inside stays a Server Component
 * — React resolves context by position in the rendered tree, so the client
 * components nested in these server ones still read it.
 */
export default async function OverviewPage() {
  const { business } = await requireBusiness()

  const [
    upcoming,
    stats,
    services,
    callAlert,
    progress,
    needsAttention,
    openEnquiries,
    liveCalls,
  ] = await Promise.all([
    listUpcomingAppointments(business.id),
    appointmentStats(business.id),
    listServices(business.id),
    loadCallAlert(business.id),
    batchProgress(business.id),
    listNeedsAttention(business.id),
    listOpenEnquiries(business.id),
    listLiveCalls(business.id),
  ])

  /*
    Only the first Service's Slots are loaded here. Slot size is the Service
    duration, so one Service's times cannot be reused for another, and
    pre-computing every Service would make this page cost grow with the Service
    count. Changing the Service in the card calls `slotOptionsAction` for the
    rest.
  */
  const firstService = services[0]
  const initialSlots = firstService
    ? await slotOptionsAction(firstService.id)
    : []

  return (
    <CsvUploadProvider>
      <div className="flex flex-col gap-8">
        {/*
          Renders nothing. It asks the server to look at Google Calendar again
          once this screen loads, which is how a conflicting event the owner
          added AFTER Callzie booked ever gets noticed (#20). Any Collision it
          raises shows up in the Needs Attention panel below.
        */}
        <CollisionCheck />

        <div className="workspace-intro">
          <div><p className="workspace-eyebrow">{business.name}</p><h2>A little more room in your day.</h2><p>Your appointments, your follow-ups, and everything Maya has taken care of.</p></div>
          <div className="workspace-maya-chip"><Image src="/maya-avatar.png" alt="" width={34} height={34} /><span>Your AI calling assistant</span></div>
        </div>
        <StatStrip stats={stats} />

        {/*
          First of the three amber surfaces, because it is the one that stops
          everything: while the Retell balance is empty, pressing "Call now"
          cannot work. It renders nothing unless the most recent Call hit it.
        */}
        <CallAlert kind={callAlert} />

        {/*
          Above the Quick call card, so a report is the first thing on screen
          after an upload. It renders nothing until a file has run.
        */}
        <CsvRejections />

        {/*
          The demo path, full width and inside the one ink border on the screen.
          It used to be the middle of three equal columns, which made the thing
          the whole product is for look like a sidebar widget.
        */}
        <QuickCallCard
          services={services}
          initialSlots={initialSlots}
          timezone={business.timezone}
          phoneCallsEnabled={business.phoneCallsEnabled}
          firstRun={stats.callsPlaced === 0}
        />

        {/* Renders nothing unless Maya is on a call this second. */}
        <LiveCallsStrip calls={liveCalls} timezone={business.timezone} />

        {/*
          Above the table, so a running batch is visible without scrolling. It
          renders nothing unless something is queued or a Phone Call is live.
        */}
        <BatchStrip initial={progress} />

        {/*
          Directly above the table, which is where SPEC.md §11.3's numbering
          puts it — stat strip, Quick call card, Needs Attention, table. Below
          the batch strip on purpose: the strip is what is happening right now
          and clears itself, this is what stopped and will wait until somebody
          deals with it.

          The third amber surface on this screen, and the only one of the three
          that reads from the database. `CallAlert` is the newest Call's
          disconnection reason and `CsvRejections` is the last upload's report;
          neither is a `needs_attention_reason`. They share the colour because
          they share the meaning — a human has to act — not because they are the
          same thing.
        */}
        {/*
          Above Needs Attention. Somebody who rang last night and was promised a
          callback is the more time-sensitive of the two, and the only one of
          the two actively waiting on a human (issue #43).
        */}
        <OpenEnquiries rows={openEnquiries} />

        <NeedsAttention rows={needsAttention} timezone={business.timezone} />

        <AppointmentsTable
          appointments={upcoming.rows}
          total={upcoming.total}
          timezone={business.timezone}
          toolbar={
            <div className="flex items-center gap-2">
              <UploadCsvButton timezone={business.timezone} />
              {/*
                Hidden without phone calls rather than shown and refusing.
                On a web-call account "Call all" can only ever explain why it
                will not work, and a button whose whole job is to say no is
                worse than no button.
              */}
              {business.phoneCallsEnabled ? <CallAllButton /> : null}
            </div>
          }
        />
      </div>
    </CsvUploadProvider>
  )
}
