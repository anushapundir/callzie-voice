"use client"

import * as React from "react"

import { saveBusinessHoursAction } from "@/app/(app)/settings/actions"
import { SavedNote } from "@/components/settings/saved-note"
import { Callout } from "@/components/ui/callout"
import { FieldError } from "@/components/ui/field-error"
import { Input } from "@/components/ui/input"
import { PageHeader } from "@/components/ui/page-header"
import { PendingSubmitButton } from "@/components/ui/pending-submit-button"
import { Switch } from "@/components/ui/switch"
import {
  INITIAL_HOURS_STATE,
  type HoursValues,
} from "@/lib/settings/hours-input"
import type { SettingsHoursRow } from "@/lib/settings/load-settings"
import { weekdayLabel } from "@/lib/settings/weekdays"
import { formatInZone } from "@/lib/time/zone"
import { cn } from "@/lib/utils"

/**
 * The weekly opening-hours table in Settings (issue #5) — seven rows, one save.
 *
 * Business Hours are the input to everything the product does: Availability is
 * computed from them (SPEC.md §5), so a Business with none can offer no Slot and
 * take no booking. That is why the whole week is one form with one submit rather
 * than seven independently saved rows — "open at least one day" is a property of
 * the week, and it can only be checked against a whole submission.
 *
 * Four things about this form are load-bearing and none of them are obvious:
 *
 * **The timezone is named once, above.** `business_hours` stores wall-clock
 * times, never instants — `"09:00"` carries no offset of its own, so on its own
 * it is not a time anybody can act on. The Business's zone sits at the top of
 * the Settings page and in this section's description, which is what makes all
 * fourteen values here mean something.
 *
 * **Openness is React state, seeded from the `hours` prop.** Toggling a day open
 * has to show its times immediately; a server round trip to reveal two fields
 * would be absurd. That state is also the only place the open/closed decision
 * lives — see the hidden input below for why it is not Radix's.
 *
 * **A closed day shows the word "Closed", not two greyed-out boxes.** Those
 * fields unmount, so times typed and not saved on a day that is then closed are
 * gone when it reopens — it goes back to what is stored. That is the honest
 * behaviour: a closed day's times are not submitted either, so keeping them on
 * screen would show a value the save would ignore.
 *
 * **A save can warn but never fails on conflicts.** Narrowing hours can strand
 * Appointments already on the books, and `saveBusinessHoursAction` deliberately
 * writes first and reports afterwards (see its comment). So `state.outOfHours` is
 * rendered as a warning next to a *successful* save, never as a rejection — and
 * it is one of the few things on this screen that stays a `Callout`, because it
 * names appointments somebody has to go and look at. A plain save says "Saved"
 * for three seconds and gets out of the way.
 *
 * Errors render inline and persist rather than as a toast (§11.4 reserves toasts
 * for transient results), and a rejected submit repopulates from `state.values`
 * — React resets the `<form>` once an action completes, so without that echo a
 * single mistyped Tuesday would blank the other six days' edits.
 */

/*
  The three field names one weekday row submits.

  Centralised because this is the single sharpest failure mode in this file:
  `parseBusinessHoursInput` reads these exact strings back out of the FormData,
  nothing type-checks the two halves against each other, and every possible typo
  fails *quietly*. A wrong `open-N` posts a day the parser reads as closed; a
  wrong `opensAt-N` posts a day the parser reads as timeless. Neither throws,
  neither logs, and both look like the user's mistake.
*/
const openName = (weekday: number) => `open-${weekday}`
const opensAtName = (weekday: number) => `opensAt-${weekday}`
const closesAtName = (weekday: number) => `closesAt-${weekday}`

/*
  A time field, set in the mono face with the browser's own furniture removed.

  `<input type="time">` draws a small clock button on the right in Chrome and
  Edge and renders its value in the browser's UI font, which is the one piece of
  operating-system chrome on an otherwise typeset screen — fourteen of them, in
  a column. `::-webkit-calendar-picker-indicator` is the clock; hiding it and
  setting the mono face on the editable part leaves a field that looks like every
  other field here. The native input is kept for what it is good at: the numeric
  keypad on a phone, the arrow keys, and a value that is always `HH:MM` when it
  reaches the server, whatever the browser chose to display.
*/
const TIME_FIELD =
  "font-mono [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-datetime-edit]:font-mono"

export function BusinessHoursForm({
  hours,
  timezone,
}: {
  hours: SettingsHoursRow[]
  timezone: string
}): React.JSX.Element {
  const [state, formAction] = React.useActionState(
    saveBusinessHoursAction,
    INITIAL_HOURS_STATE
  )

  /*
    Only the days the person has toggled *in this session*, not a copy of the
    whole week.

    Holding overrides rather than a seeded seven-entry map is what lets the three
    sources of truth stack in the right order without any effect to keep them in
    sync: what they just toggled beats what the server echoed back, which beats
    what is stored. A seeded map would have to be re-seeded every time an action
    returned, and re-seeding at the wrong moment is precisely how a form starts
    contradicting what is on screen.
  */
  const [toggled, setToggled] = React.useState<
    Partial<Record<number, boolean>>
  >({})

  const echo = state.values
  const saved = state.saved === true
  const outOfHours = state.outOfHours ?? []

  return (
    <section className="workspace-settings-section">
      <PageHeader
        title="Business hours"
        description={`When Maya may offer appointments — all times in ${timezone}.`}
      />

      <form action={formAction} className="flex flex-col gap-5">
        {/*
          Above the table, because "open at least one day" is a fact about the
          whole week and no single row is at fault — the same reason
          `parseBusinessHoursInput` reports it as `errors.form` rather than
          hanging it on Sunday.
        */}
        <FieldError id="hours-form-error" message={state.errors?.form} />

        {/* `min-w-0`: a fieldset's default min-width is `min-content`, which
            stops it shrinking inside a flex column and would push the seven rows
            past a 375px viewport (§11.4). */}
        <fieldset
          className="min-w-0"
          aria-describedby={state.errors?.form ? "hours-form-error" : undefined}
        >
          {hours.map((row) => {
            const { weekday } = row
            /*
              From the weekday number rather than `row.label`, so the name the
              person reads and the names the row submits are derived from the
              same value. A row mislabelled by one would otherwise put Monday's
              heading on Tuesday's fields and be invisible to every check.
            */
            const label = weekdayLabel(weekday)

            /*
              `open-N` is echoed only for ticked days and always as the literal
              `"on"` — a switch, like a checkbox, submits nothing at all when it
              is off. So presence is the question, exactly as the parser asks it.
            */
            const echoedOpen = echo
              ? submitted(echo, openName(weekday)) !== undefined
              : undefined
            const isOpen = toggled[weekday] ?? echoedOpen ?? row.open

            /*
              A closed row submits nothing for its times — the fields are not on
              screen — so the echo for a closed day is two empty strings, not the
              times that were sitting behind the switch. Reading it anyway would
              blank those inputs on every rejected save. The stored value is the
              honest fallback: it is what the row was last saved with.
            */
            const echoedTimes = echo && echoedOpen ? echo : undefined
            const opensAt =
              submitted(echoedTimes, opensAtName(weekday)) ?? row.opensAt
            const closesAt =
              submitted(echoedTimes, closesAtName(weekday)) ?? row.closesAt

            const error = state.errors?.days?.[weekday]
            const errorId = `hours-error-${weekday}`
            const labelId = `hours-day-${weekday}`

            return (
              <div
                key={weekday}
                className="flex flex-col gap-2 border-b border-line py-3 last:border-b-0"
              >
                {/* Stacks under 640px so two time fields and a weekday never
                    have to share 375px of width. */}
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
                  <div className="flex items-center gap-3">
                    <Switch
                      checked={isOpen}
                      /*
                        Toggled on `onClick`, with no `onCheckedChange`, and
                        deliberately so.

                        React resets the enclosing `<form>` once an action
                        completes. Radix listens for that reset and calls its
                        internal setter with the switch's mount-time value — so
                        with an `onCheckedChange` handler wired up, every save
                        would snap all seven switches back to whatever the week
                        looked like when the page loaded, silently discarding the
                        change the person just made. A controlled Radix switch
                        with no change handler makes that reset a genuine no-op:
                        the setter has nothing to call, and `checked` is ours.
                        `components/business-type-picker.tsx` hit the same reset
                        from the other direction.

                        A click covers keyboard activation too — Space and Enter
                        on a `<button role="switch">` both dispatch one.
                      */
                      onClick={() =>
                        setToggled((previous) => ({
                          ...previous,
                          [weekday]: !isOpen,
                        }))
                      }
                      aria-labelledby={labelId}
                    />

                    {/*
                      Our own hidden input, not the one Radix bubbles for `name`.

                      Radix's bubbled checkbox carries a `defaultChecked` fixed at
                      mount, so the post-action form reset sets it back to that
                      while the visible switch — driven by React state — keeps the
                      new position. The two then disagree with nothing on screen
                      to show it: the row reads "open" and the next submit posts
                      it closed. One `isOpen` rendering both the switch and the
                      field it submits cannot drift.

                      Value `"on"` to match what a native checkbox sends and what
                      `parseBusinessHoursInput` echoes back, though the parser
                      only ever tests presence.
                    */}
                    {isOpen ? (
                      <input
                        type="hidden"
                        name={openName(weekday)}
                        value="on"
                      />
                    ) : null}

                    <span
                      id={labelId}
                      className={cn(
                        "text-body",
                        isOpen ? "text-text" : "text-text-muted"
                      )}
                    >
                      {label}
                    </span>
                  </div>

                  {isOpen ? (
                    <div className="flex min-w-0 items-center gap-2 sm:ml-auto">
                      {/*
                        No `required`: the browser's own bubble is unstyled, fires
                        before the action runs, and cannot express the rule that
                        actually matters here (close must be after open). The
                        server owns validation and answers with an inline message
                        per weekday, which is the designed path.
                      */}
                      <Input
                        type="time"
                        name={opensAtName(weekday)}
                        defaultValue={opensAt}
                        aria-label={`${label} opens at`}
                        aria-invalid={Boolean(error) || undefined}
                        aria-describedby={error ? errorId : undefined}
                        className={cn("w-full sm:w-28", TIME_FIELD)}
                      />
                      <span aria-hidden className="text-body text-text-muted">
                        –
                      </span>
                      <Input
                        type="time"
                        name={closesAtName(weekday)}
                        defaultValue={closesAt}
                        aria-label={`${label} closes at`}
                        aria-invalid={Boolean(error) || undefined}
                        aria-describedby={error ? errorId : undefined}
                        className={cn("w-full sm:w-28", TIME_FIELD)}
                      />
                    </div>
                  ) : (
                    /*
                      One word where two disabled fields used to sit at half
                      opacity. A closed day has no times to read, and the pair of
                      greyed boxes said "these are here but you cannot have them"
                      rather than "we are shut".
                    */
                    <span className="text-table text-text-muted sm:ml-auto">
                      Closed
                    </span>
                  )}
                </div>

                <FieldError id={errorId} message={error} />
              </div>
            )
          })}
        </fieldset>

        {/*
          The one message on this screen that stays put. Narrowed hours can
          strand appointments already on the books, and that is work for a person
          rather than news about a save — §11.4 wants it inline and persistent,
          so it does not fade the way "Saved" does.
        */}
        {saved && outOfHours.length > 0 ? (
          <Callout
            tone="warning"
            title={
              outOfHours.length === 1
                ? "Hours saved — 1 appointment now falls outside them"
                : `Hours saved — ${outOfHours.length} appointments now fall outside them`
            }
          >
            <p>
              Nothing was cancelled and nothing moved. These appointments are
              still on the books, but they sit outside the hours you just saved,
              so Maya would not offer their times again.
            </p>
            <ul className="mt-2 flex flex-col gap-1">
              {outOfHours.map((appointment) => (
                <li
                  key={appointment.id}
                  className="flex flex-wrap items-baseline gap-x-2"
                >
                  <span className="font-medium text-text">
                    {appointment.name}
                  </span>
                  <span aria-hidden>·</span>
                  <span>{appointment.serviceName}</span>
                  <span aria-hidden>·</span>
                  {/* A clock time, so the mono face — the same treatment the
                      appointments table gives it. */}
                  <span className="font-mono text-text">
                    {formatInZone(appointment.startsAt, timezone)}
                  </span>
                </li>
              ))}
            </ul>
          </Callout>
        ) : null}

        {/*
          The result of the save sits next to the button that caused it, rather
          than at the top of the section: on a 375px screen the table is taller
          than the viewport, and a confirmation above it would land off-screen at
          the moment it was produced.
        */}
        <div className="flex items-center justify-end gap-3">
          <SavedNote token={saved && outOfHours.length === 0 ? state : null} />
          <PendingSubmitButton label="Save" pendingLabel="Saving…" />
        </div>
      </form>
    </section>
  )
}

/**
 * One echoed field, typed honestly.
 *
 * `HoursValues` is a `Record<string, string>`, so TypeScript believes every key
 * it is asked for is present. The optional index here is what turns "was this
 * field submitted?" back into a question the compiler will let us ask — and
 * presence, not value, is the entire meaning of the `open-N` field.
 */
function submitted(
  values: HoursValues | undefined,
  name: string
): string | undefined {
  return values?.[name]
}
