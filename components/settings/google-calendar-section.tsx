import type * as React from "react"

import { disconnectGoogleCalendarAction } from "@/app/(app)/settings/actions"
import { PendingSubmitButton } from "@/components/ui/pending-submit-button"
import { SettingsCallout, SettingsSection } from "@/components/settings/section"
import { Button } from "@/components/ui/button"
import {
  GOOGLE_STATUS_MESSAGES,
  type GoogleConnection,
  type GoogleStatus,
} from "@/lib/google/connection"

/**
 * The Google Calendar connection (SPEC.md §11.3, "connect button (flagged)").
 *
 * Three states, and `lib/google/connection.ts` insists they stay three: a
 * deployment can be **not configured** (no Google credentials in the
 * environment, identical for every Business) or a Business can be **not
 * connected** (no completed handshake). Collapsing them is how a Connect button
 * ends up rendering on a deployment that cannot honour it. ADR-0004 makes both
 * ordinary states rather than faults — Callzie "must be fully functional for a
 * Business that never connects Google" — so neither branch renders as an error,
 * and the not-configured branch says so in as many words.
 *
 * **What this section may claim.** Storing the connection is all issue #5 does.
 * Pushing Appointments to the calendar and raising Collisions is ADR-0004's
 * one-way push, which is issue #20 and has not shipped. Copy that implied
 * events were syncing would leave an owner double-booked and trusting a
 * calendar Callzie has never written to, so the connected state says exactly
 * what is and is not happening.
 *
 * A Server Component, and it has to be one: `GOOGLE_STATUS_MESSAGES` lives
 * beside `storeGoogleConnection` in a module that imports `@/lib/db`, so it
 * cannot cross into the client graph. That has one visible cost — the Disconnect
 * button has no per-button spinner, because `useFormStatus` would need a client
 * child and this task's file list has no module to put one in. The action is a
 * single scoped `UPDATE` with no third-party call in it, and the section
 * re-renders from `revalidatePath("/settings")` when it lands. Worth closing
 * with a one-button client module the day one exists; flagged rather than
 * faked.
 */

/**
 * Which callout each status gets.
 *
 * A `Record` rather than a list of the two happy ones, so a status added to
 * `GOOGLE_STATUSES` fails to compile here until someone decides whether it is
 * good news. `denied` is a warning despite being a deliberate user action: the
 * connection they came here to make did not happen, and §11.4 wants the thing
 * that still needs doing left on screen.
 */
const STATUS_TONE: Record<GoogleStatus, "success" | "warning"> = {
  connected: "success",
  disconnected: "success",
  denied: "warning",
  unavailable: "warning",
  invalid_state: "warning",
  expired_state: "warning",
  exchange_failed: "warning",
  no_refresh_token: "warning",
}

export function GoogleCalendarSection({
  connection,
  status,
}: {
  connection: GoogleConnection
  status: GoogleStatus | null
}): React.JSX.Element {
  return (
    <SettingsSection
      title="Google Calendar"
      description="Optional. Callzie books against its own calendar, so everything works whether or not this is connected."
    >
      <div className="flex flex-col gap-5">
        {/*
          The callback has no UI of its own — every exit from it, successful or
          not, arrives here as `?google=…`. The copy is written once in
          `GOOGLE_STATUS_MESSAGES` so the reason a handshake failed survives the
          redirect intact; restating it here would let the two drift.
        */}
        {status ? (
          <SettingsCallout tone={STATUS_TONE[status]}>
            {GOOGLE_STATUS_MESSAGES[status]}
          </SettingsCallout>
        ) : null}

        {!connection.configured ? (
          <NotConfigured />
        ) : connection.connected ? (
          <Connected calendarId={connection.calendarId} />
        ) : (
          <NotConnected accessLostAt={connection.accessLostAt} />
        )}
      </div>
    </SettingsSection>
  )
}

/**
 * No Connect button, deliberately.
 *
 * `/api/google/start` refuses on an unconfigured deployment and redirects
 * straight back here with `unavailable`, so a button would be a round trip to
 * the same screen. The environment variables that switch this on are named on
 * the admin-only configuration panel and nowhere else — this section is visible
 * to every account, and `lib/settings/env-status.ts` is explicit that what a
 * panel reveals about a deployment is reconnaissance for anyone holding an
 * account on an open-signup product.
 */
function NotConfigured(): React.JSX.Element {
  return (
    <p className="max-w-prose text-table text-text-muted">
      Google Calendar is not set up on this deployment, so there is nothing to
      connect. Nothing is missing from your account: availability, bookings and
      calls are all worked out from Callzie&apos;s own records and never depend
      on Google.
    </p>
  )
}

/**
 * `accessLostAt` is the difference between "you have not connected" and "you
 * did, and it stopped working". Without it an owner whose grant expired
 * overnight finds the Connect button back with no explanation and concludes
 * Callzie lost their settings.
 */
function NotConnected({
  accessLostAt,
}: {
  accessLostAt: Date | null
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      {accessLostAt ? (
        <SettingsCallout tone="warning">
          Callzie&apos;s access to your Google Calendar has ended, so bookings
          are no longer being added to it. Connect again to restart. Everything
          else is unaffected.
        </SettingsCallout>
      ) : null}

      <p className="max-w-prose text-table text-text-muted">
        Connecting lets Callzie add your appointments to one of your Google
        calendars and check it for clashes. Availability is still worked out
        from Callzie&apos;s own records, so anything you put in Google by hand
        is flagged for you rather than booked around.
      </p>

      {/*
        The seven-day expiry, said before somebody hits it rather than after.

        Google issues a refresh token lasting one week to any app whose consent
        screen is in Testing status and which asks for a sensitive scope, which
        `calendar.events` is. ADR-0004 chose Testing status deliberately —
        verification takes weeks — so this is the accepted cost of that, not a
        fault. An owner who reconnects on Monday and finds it broken the
        following Tuesday with no warning concludes the product is broken.
      */}
      <p className="max-w-prose text-table text-text-muted">
        While Callzie&apos;s Google app is still under review, a connection
        lasts seven days and then needs making again.
      </p>
      <div>
        {/*
          A plain `<a>`, not `next/link`. `/api/google/start` is a Route
          Handler that mints a signed, single-Business `state` and redirects to
          accounts.google.com; `Link` would prefetch it on hover, burning a
          state and starting a handshake nobody asked for. `asChild` keeps the
          button's styling on an element that is genuinely a navigation.

          `outline` rather than the accent: §11.2 keeps the teal for primary
          actions, and ADR-0004 makes this integration optional by design — an
          accent button here would shout at an owner who is complete without it.
        */}
        <Button asChild variant="outline">
          <a href="/api/google/start">Connect Google Calendar</a>
        </Button>
      </div>
    </div>
  )
}

function Connected({
  calendarId,
}: {
  calendarId: string | null
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      {calendarId ? (
        <div className="flex flex-col gap-1">
          <p className="text-table text-text-muted">Connected calendar</p>
          {/* Mono, and wrapping: a calendar id is an identifier to compare
              character by character, and it is usually an email address long
              enough to overflow the card at 375px. */}
          <p className="font-mono text-body break-all text-text">{calendarId}</p>
        </div>
      ) : null}

      {/*
        This paragraph used to say the opposite, and the comment at the top of
        this file explains why that mattered: copy implying sync would have left
        an owner double-booked and trusting a calendar Callzie had never written
        to. #20 reversed the facts, and stale copy would now be the same failure
        pointed the other way.

        The limitation in the second sentence is the one ADR-0004 asks to be
        stated rather than omitted. It belongs in the README, and there is no
        README yet — that is M7 — so it goes where an owner will actually read
        it.
      */}
      <p className="max-w-prose text-table text-text-muted">
        Callzie adds each booking to this calendar, and checks the same time
        afterwards for anything already there. A clash does not stop the
        booking: Callzie flags it for you and stops calling that person until
        you have looked. Events you create in Google never change what Callzie
        offers a caller.
      </p>

      <p className="max-w-prose text-table text-text-muted">
        While Callzie&apos;s Google app is still under review, this connection
        lasts seven days and then needs making again.
      </p>

      <form action={disconnectGoogleCalendarAction}>
        {/*
          A client child purely so the button can report its own pending state —
          this section is a Server Component (it reads `lib/google/connection.ts`,
          which imports the database) and `useFormStatus` is a client hook that
          must sit *inside* the form it reports on.
        */}
        <PendingSubmitButton
          label="Disconnect"
          pendingLabel="Disconnecting…"
          variant="destructive"
        />
      </form>

      <p className="max-w-prose text-table text-text-muted">
        Disconnecting deletes Callzie&apos;s copy of the permission. The grant
        itself stays on your Google account until you remove Callzie at
        myaccount.google.com/permissions.
      </p>
    </div>
  )
}
