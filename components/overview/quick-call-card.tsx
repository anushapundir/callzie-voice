"use client"

import * as React from "react"

import {
  addAppointmentAction,
  slotOptionsAction,
  type SlotOption,
} from "@/app/(app)/actions"
import { useLiveCall } from "@/components/calls/live-call-provider"
import { Card } from "@/components/ui/card"
import { FieldError } from "@/components/ui/field-error"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PendingSubmitButton } from "@/components/ui/pending-submit-button"
import {
  INITIAL_QUICK_ADD_STATE,
  MAX_NAME_LENGTH,
} from "@/lib/appointments/quick-add-input"
import { cn } from "@/lib/utils"

/**
 * The Quick call card (SPEC.md §11.3) — the demo path, and the one object on
 * Overview with a box around it.
 *
 * Everything else on this screen is a run of rows held apart by hairlines. This
 * is a thing you act *inside*, so it gets the ink border, full width, directly
 * under the figures. It is also the only `default` button on the page: the
 * toolbar above the table is deliberately quiet so that "Call now" is the one
 * thing that looks like the next move.
 *
 * **One accent button, and it says "Call now."** That is what §11.3 asks this
 * card to be: a single submit that creates the Appointment and then starts a Web
 * Call to it. The two halves are deliberately not separate buttons — the card
 * exists to be the shortest path from an empty form to Maya talking, and adding
 * without calling is what the table's own rows and CSV upload are for.
 *
 * The dial is chained in an effect rather than inside the action, because the
 * Appointment has to exist before it can be called, and only the server knows
 * whether it was created. The action returns the new id; the effect calls it.
 *
 * **The time picker offers only Slots Availability actually has open.** They
 * arrive from `slotOptionsAction`. The list can still go stale between render
 * and submit, and that is what the "someone just booked that time" refusal is
 * for — the correct outcome, not a defect to design away.
 *
 * A native `<select>` rather than a combobox: `components/ui` has no Select, the
 * option lists are short, and a native control gets keyboard behaviour and
 * mobile pickers for free.
 */

/*
  The native `<select>`s, styled to match `components/ui/input.tsx` exactly.

  There is no Select in `components/ui`, and the two controls sit in the same
  row as Name and Phone — so a different height or background is visible as a
  wobble in the row. Every value here is copied from `Input` rather than chosen:
  `h-8`, `px-2.5`, `bg-transparent`, and the same `aria-invalid` and `disabled`
  treatments, so a bad Service gets the same red border a bad phone number does.

  No focus ring of its own. `app/globals.css` gives every focusable element the
  accent outline at 2px offset, and a component that drew its own would double it.
*/
const SELECT_CLASS = cn(
  "h-8 w-full min-w-0 rounded-control border border-line bg-transparent px-2.5 py-1 text-body text-text transition-colors",
  "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
  "aria-invalid:border-destructive",
)

/** 13px and muted, so the four labels sit under the heading, not beside it. */
const LABEL_CLASS = "text-table text-text-muted"

type QuickCallCardProps = {
  services: { id: string; name: string; durationMinutes: number }[]
  /** The open Slots for `services[0]`, rendered on the server so the card is
   *  usable on first paint without a round trip. */
  initialSlots: SlotOption[]
  /** The Business's IANA zone — times mean nothing without it. */
  timezone: string
  /**
   * Whether this account places real phone calls.
   *
   * When it does not, pressing "Call now" opens a conversation in this browser
   * tab and the person at the keyboard plays the customer. Nobody was telling a
   * new signup that: the only screen that explained it is behind the admin gate,
   * so the first Call came as a surprise and the microphone prompt looked like a
   * bug.
   */
  phoneCallsEnabled: boolean
  /** No Call has ever been placed on this account, so say what to do. */
  firstRun: boolean
}

export function QuickCallCard({
  services,
  initialSlots,
  timezone,
  phoneCallsEnabled,
  firstRun,
}: QuickCallCardProps) {
  const [state, formAction] = React.useActionState(
    addAppointmentAction,
    INITIAL_QUICK_ADD_STATE,
  )

  const [serviceId, setServiceId] = React.useState(services[0]?.id ?? "")
  const [slots, setSlots] = React.useState(initialSlots)
  const [loadingSlots, startLoadingSlots] = React.useTransition()

  const { busy, start } = useLiveCall()

  const formRef = React.useRef<HTMLFormElement>(null)

  /*
    Which Slot request is the current one.

    Two changes in quick succession — Haircut, Colour, Haircut — start two
    fetches that can come back in either order, and the loser would leave the
    select showing one Service's name over another Service's grid. Every submit
    from that state is refused with "that is not a time you can book", which is
    a baffling thing to be told about a time the page itself offered. Only the
    newest request is allowed to write.
  */
  const latestRequest = React.useRef(0)

  function loadSlots(forServiceId: string) {
    const request = ++latestRequest.current
    startLoadingSlots(async () => {
      const next = await slotOptionsAction(forServiceId)
      if (request === latestRequest.current) setSlots(next)
    })
  }

  /*
    Clear the fields once an Appointment lands, so the next one starts empty,
    and refetch the times.

    The refetch is not optional. `slots` is React state seeded once from
    `initialSlots`, and state survives a re-render — so the fresh list the
    server sends after `revalidatePath("/")` is dropped on the floor. Without
    this the card keeps offering the Slot that was just taken, the form reset
    reselects it as the first option, and the very next submit is refused with
    "someone just booked that time". They did: it was this person, a moment ago.

    The inputs are uncontrolled, and an uncontrolled input does not clear just
    because its `defaultValue` went away — resetting the form element is what
    actually empties them. The Service select survives, because it is controlled
    by React state rather than the DOM. That is the behaviour worth having:
    adding several Appointments for the same Service is the common case.
  */
  React.useEffect(() => {
    if (!state.added) return
    formRef.current?.reset()
    loadSlots(serviceId)
    /*
      And then call the person, which is what the button promised.

      Here rather than inside the action because the Appointment has to exist
      before it can be called, and the Call needs the browser — the microphone
      is requested before anything is spent, which a Server Action cannot do.
    */
    start({ appointmentId: state.added.id, name: state.added.name })
    // `serviceId` is deliberately not a dependency — this must run when an
    // Appointment lands, not when the Service changes. `changeService` already
    // handles that, and adding it here would refetch twice on every switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.added])

  function changeService(nextServiceId: string) {
    setServiceId(nextServiceId)
    // Slot size is the Service duration, so the previous Service's times are
    // not merely stale — they are the wrong length. Cleared before the fetch so
    // no time from the old list can be submitted against the new Service.
    setSlots([])
    loadSlots(nextServiceId)
  }

  return (
    <Card tone="ink" id="quick-call" className="workspace-quick-call">
      <div className="flex flex-col gap-1 pb-4">
        <h2 className="text-section text-text">Quick call</h2>
        {firstRun && (
          <p className="text-table text-text-muted">
            Start with one appointment. Maya will take care of the conversation.
          </p>
        )}
        {!phoneCallsEnabled && (
          <p className="text-table text-text-muted">
            Maya talks to you here in the browser; you play the customer.
          </p>
        )}
      </div>

      <form ref={formRef} action={formAction} className="flex flex-col gap-4">
        <FieldError id="quick-add-form-error" message={state.errors?.form} />

        {/*
          One row of four on a wide screen, one field per row on a phone — which
          with the button underneath is the five-row stack §11.4's 375px floor
          asks for.
        */}
        <div className="grid gap-4 lg:grid-cols-4">
          <div className="flex flex-col gap-2">
            <Label className={LABEL_CLASS} htmlFor="quick-add-name">
              Name
            </Label>
            <Input
              id="quick-add-name"
              placeholder="Customer’s full name"
              name="name"
              maxLength={MAX_NAME_LENGTH}
              defaultValue={state.values?.name}
              aria-invalid={Boolean(state.errors?.name) || undefined}
              aria-describedby={
                state.errors?.name ? "quick-add-name-error" : undefined
              }
            />
            <FieldError id="quick-add-name-error" message={state.errors?.name} />
          </div>

          <div className="flex flex-col gap-2">
            <Label className={LABEL_CLASS} htmlFor="quick-add-phone">
              Phone
            </Label>
            <Input
              id="quick-add-phone"
              name="phone"
              inputMode="tel"
              /*
                The same number the CSV example shows, and the same one the
                seeded rows use. Two placeholders in two different countries on
                one screen made the format look like a guess.
              */
              placeholder="+1 202 555 0110"
              // Mono — phone numbers are one of the five things it is for.
              className="font-mono"
              defaultValue={state.values?.phone}
              aria-invalid={Boolean(state.errors?.phone) || undefined}
              aria-describedby={
                state.errors?.phone ? "quick-add-phone-error" : undefined
              }
            />
            <FieldError
              id="quick-add-phone-error"
              message={state.errors?.phone}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label className={LABEL_CLASS} htmlFor="quick-add-service">
              Service
            </Label>
            <select
              id="quick-add-service"
              name="serviceId"
              value={serviceId}
              onChange={(event) => changeService(event.target.value)}
              className={SELECT_CLASS}
              aria-invalid={Boolean(state.errors?.serviceId) || undefined}
              aria-describedby={
                state.errors?.serviceId ? "quick-add-service-error" : undefined
              }
            >
              {services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name} · {service.durationMinutes} min
                </option>
              ))}
            </select>
            <FieldError
              id="quick-add-service-error"
              message={state.errors?.serviceId}
            />
          </div>

          <div className="flex flex-col gap-2">
            {/* The zone lives on the label rather than in a sentence under the
                heading, the same way the table puts it on its column header. */}
            <Label className={LABEL_CLASS} htmlFor="quick-add-time">
              Time ({timezone})
            </Label>
            {/*
              Disabled while the times are loading, which also settles what
              happens if someone submits mid-fetch: a disabled control is left
              out of the `FormData` entirely, so the action sees no `startsAt`
              and answers "Choose a time." rather than throwing on a value that
              belongs to the Service they just switched away from.
            */}
            <select
              id="quick-add-time"
              name="startsAt"
              disabled={loadingSlots || slots.length === 0}
              defaultValue={state.values?.startsAt}
              className={cn(SELECT_CLASS, "font-mono")}
              aria-invalid={Boolean(state.errors?.startsAt) || undefined}
              aria-describedby={
                state.errors?.startsAt ? "quick-add-time-error" : undefined
              }
            >
              {loadingSlots && <option value="">Loading times…</option>}
              {!loadingSlots && slots.length === 0 && (
                <option value="">No open times in the next two weeks</option>
              )}
              {slots.map((slot) => (
                <option key={slot.value} value={slot.value}>
                  {slot.label}
                </option>
              ))}
            </select>
            <FieldError
              id="quick-add-time-error"
              message={state.errors?.startsAt}
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-4">
          {/*
            Inline and persistent, not a toast. The row this refers to has just
            landed somewhere in a twenty-row table, and §11.4 reserves toasts for
            transient results.

            It also carries the reason the button is dead mid-Call. That used to
            be a `title`, which reaches sighted mouse users and nobody else —
            not a keyboard user, because a disabled button is out of the tab
            order, and not a finger, because tooltips do not fire on a tap.
          */}
          <p className="text-table text-text-muted" role="status">
            {busy
              ? "Finish the call in progress first."
              : state.added
                ? `Added ${state.added.name}, ${state.added.startsAt}.`
                : ""}
          </p>
          {/*
            Disabled while another Call is in flight, the same as every "Call
            now" in the table, and for a sharper reason than symmetry.

            This button does two things: it creates the Appointment, then the
            effect above calls `start`. `start` refuses while a Call is in
            flight — so without this, submitting mid-Call would add the
            Appointment and place no Call at all, silently.
          */}
          <PendingSubmitButton
            label="Call now"
            pendingLabel="Starting…"
            disabled={busy}
          />
        </div>
      </form>
    </Card>
  )
}

/*
  Nothing here reports on the Call itself. Once the Appointment lands, the bar
  under the topbar owns every state from "waiting for microphone permission" to
  "hang up" — including the two failures — so this card has one job and stops.
*/
