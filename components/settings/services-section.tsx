"use client"

import { Loader2 } from "lucide-react"
import * as React from "react"
import { useFormStatus } from "react-dom"

import {
  addServiceAction,
  deleteServiceAction,
  updateServiceAction,
} from "@/app/(app)/settings/actions"
import { FieldLabel } from "@/components/settings/section"
import { SavedNote } from "@/components/settings/saved-note"
import { Button } from "@/components/ui/button"
import { Callout } from "@/components/ui/callout"
import { FieldError } from "@/components/ui/field-error"
import { Input } from "@/components/ui/input"
import { PageHeader } from "@/components/ui/page-header"
import type { SettingsServiceRow } from "@/lib/settings/load-settings"
import {
  INITIAL_SERVICES_STATE,
  MAX_SERVICE_MINUTES,
  MAX_SERVICE_NAME_LENGTH,
  MIN_SERVICE_MINUTES,
  type ServicesState,
} from "@/lib/settings/services-input"

/**
 * The Services a Business offers, with add, edit and remove (issue #5, SPEC.md
 * §11.3).
 *
 * **Three `useActionState` calls, not one.** Adding, editing and removing are
 * three different writes with three different failure modes — a duplicate name,
 * a row that vanished, a Service twelve Appointments still point at — and a
 * single shared state would let one form's error surface under another's
 * fields. Each also needs its own pending state, and `useActionState` has one
 * per hook.
 *
 * **A `<form>` per row, sharing those actions.** `useFormStatus` reports the
 * status of the form above the component that reads it, so a submit button
 * rendered inside row 4's own form knows only about row 4's submit. That is
 * what gives every row a spinner on the button the person actually clicked
 * (§11.4: a loading state on its own button, never a page blocker) without a
 * hook per row. The action functions are shared; the forms are not.
 *
 * **The whole row opens the editor.** The name and duration sit inside a
 * button that fills the row, so the obvious click — on the service you want to
 * change — does the obvious thing. Edit stays as a visible affordance beside it,
 * because an invisible click target is one nobody finds. The two never nest:
 * Edit and Remove are siblings of the row button, not children of it, since a
 * button inside a button is invalid HTML and behaves differently in every
 * browser.
 *
 * **Nothing here opens a browser dialog.** `window.confirm` blocks the whole
 * thread, cannot be styled, and is unreachable from a test — so removal is a
 * two-click inline step ("Remove" → "Confirm remove") held in React state.
 * Refusals from `deleteServiceAction` render as a persistent callout beside the
 * row they concern, because §11.4 reserves toasts for transient results and both
 * refusals name something the person has to go and do: cancel some Appointments,
 * or add a second Service first.
 *
 * **`appointmentCount` is on every row up front.** It is the single fact that
 * predicts whether a removal will be refused, and `lib/settings/load-settings.ts`
 * counts it the same way `deleteService` does. Showing it only after a failed
 * click would make the refusal look arbitrary.
 */

/**
 * A row the person has singled out — to edit, or to remove — together with the
 * action result that was on screen when they did.
 *
 * `seen` is the whole trick. The editor has to close itself after a save
 * succeeds and reopen itself after a save is rejected, and both facts live in
 * the Server Action's returned state rather than in any event this component
 * handles. Storing the state object that was current at the moment of the click
 * makes "has a result landed since then?" a reference comparison, so the open
 * row is *derived* during render — no `useEffect` mirroring action state into
 * local state, and no state adjustment during render either.
 *
 * The bug that pattern prevents is a real one: without it, a successful save
 * leaves the editor open over a row that has already been rewritten by
 * `revalidatePath`, so the inputs show what the person typed while the row
 * behind them shows what was stored — and the same for a "Confirm remove" that
 * stays armed after the removal it was for has been refused.
 */
type RowSelection = {
  /** `null` means "nothing open", which is different from "nothing chosen yet". */
  id: string | null
  seen: ServicesState
}

export function ServicesSection({
  services,
}: {
  services: SettingsServiceRow[]
}): React.JSX.Element {
  const [addState, addAction] = React.useActionState(
    addServiceAction,
    INITIAL_SERVICES_STATE
  )
  const [updateState, updateAction] = React.useActionState(
    updateServiceAction,
    INITIAL_SERVICES_STATE
  )
  const [deleteState, deleteAction] = React.useActionState(
    deleteServiceAction,
    INITIAL_SERVICES_STATE
  )

  /*
    Seeded with `INITIAL_SERVICES_STATE` because that is the exact object
    `useActionState` hands back before anything has been submitted — so on the
    first render `seen === updateState` and the derivation below correctly says
    "no editor open" rather than reading a result that does not exist yet.
  */
  const [editor, setEditor] = React.useState<RowSelection>({
    id: null,
    seen: INITIAL_SERVICES_STATE,
  })
  const [removal, setRemoval] = React.useState<RowSelection>({
    id: null,
    seen: INITIAL_SERVICES_STATE,
  })

  const baseId = React.useId()

  /*
    An update result the person has not yet clicked past. When there is one it
    decides which editor is open, overriding whatever they last opened by hand:
    a rejection echoes the row in `values.id`, and a success returns no `values`
    at all, which closes the editor. Cancelling or opening another row records
    the current state as `seen` and hands control back to `editor.id`.
  */
  const unseenUpdate = editor.seen === updateState ? undefined : updateState
  const editingId = unseenUpdate ? (unseenUpdate.values?.id ?? null) : editor.id

  /*
    Any settled removal disarms the confirmation, whichever way it went. A
    refusal is not something a second click can get past — the Appointments are
    still there — so leaving the button reading "Confirm remove" would invite a
    click that can only fail again.
  */
  const confirmingRemovalId = removal.seen === deleteState ? removal.id : null

  return (
    <section className="workspace-settings-section">
      <PageHeader
        title="Services"
        description="What you offer, and how long each one takes — the duration is what sizes the slot it books into."
      />

      <ul>
        {services.map((service) => {
          const editing = editingId === service.id
          // Only the row named by the rejection repopulates from it; every
          // other row keeps rendering what is stored.
          const rejection =
            unseenUpdate?.values?.id === service.id ? unseenUpdate : undefined
          const removalError =
            deleteState.values?.id === service.id
              ? deleteState.errors?.form
              : undefined

          const rowId = `${baseId}-${service.id}`

          return (
            <li key={service.id} className="border-b border-line">
              {editing ? (
                <form action={updateAction} className="flex flex-col gap-3 py-4">
                  {/*
                    `updateServiceAction` reads the Service id from a field
                    named `id` — it is never inferred from the row's position,
                    and it is never trusted as an ownership claim either:
                    `lib/settings/services.ts` settles ownership against the
                    database before it does anything else.
                  */}
                  <input type="hidden" name="id" value={service.id} />

                  <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <FieldLabel htmlFor={`${rowId}-name`}>Name</FieldLabel>
                      <Input
                        id={`${rowId}-name`}
                        name="name"
                        defaultValue={rejection?.values?.name ?? service.name}
                        maxLength={MAX_SERVICE_NAME_LENGTH}
                        autoComplete="off"
                        aria-invalid={
                          Boolean(rejection?.errors?.name) || undefined
                        }
                        aria-describedby={
                          rejection?.errors?.name
                            ? `${rowId}-name-error`
                            : undefined
                        }
                      />
                    </div>

                    <div className="flex flex-col gap-1.5 sm:w-28">
                      <FieldLabel htmlFor={`${rowId}-duration`}>
                        Minutes
                      </FieldLabel>
                      <Input
                        id={`${rowId}-duration`}
                        name="durationMinutes"
                        type="number"
                        inputMode="numeric"
                        className="font-mono"
                        defaultValue={
                          rejection?.values?.durationMinutes ??
                          String(service.durationMinutes)
                        }
                        aria-invalid={
                          Boolean(rejection?.errors?.durationMinutes) ||
                          undefined
                        }
                        aria-describedby={
                          rejection?.errors?.durationMinutes
                            ? `${rowId}-duration-error`
                            : undefined
                        }
                      />
                    </div>

                    <div className="flex gap-2">
                      <SubmitButton label="Save" pendingLabel="Saving…" />
                      <Button
                        // Opens local state; it must not post the form.
                        type="button"
                        variant="ghost"
                        onClick={() =>
                          setEditor({ id: null, seen: updateState })
                        }
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>

                  {/*
                    The messages sit under the whole row rather than under each
                    input, so a one-line error on the name field cannot shunt
                    the duration input and the buttons out of alignment beside
                    it. `aria-describedby` still ties each one to its field.
                  */}
                  <FieldError
                    id={`${rowId}-name-error`}
                    message={rejection?.errors?.name}
                  />
                  <FieldError
                    id={`${rowId}-duration-error`}
                    message={rejection?.errors?.durationMinutes}
                  />
                  {rejection?.errors?.form ? (
                    <Callout tone="warning">{rejection.errors.form}</Callout>
                  ) : null}
                </form>
              ) : (
                <div className="flex items-center gap-2 transition-colors hover:bg-surface-soft">
                  {/*
                    The row itself. `type="button"` because this opens an editor
                    and must never submit the removal form sitting beside it.
                  */}
                  <button
                    type="button"
                    onClick={() =>
                      setEditor({ id: service.id, seen: updateState })
                    }
                    className="flex min-w-0 flex-1 flex-col items-start gap-0.5 py-3 text-left"
                  >
                    <span className="w-full truncate text-body text-text">
                      {service.name}
                    </span>
                    <span className="text-table text-text-muted">
                      {/* A duration is one of the five things that take the mono
                          face; the count beside it is a figure, so it is not. */}
                      <span className="font-mono">
                        {service.durationMinutes} min
                      </span>
                      <span aria-hidden> · </span>
                      {service.appointmentCount}{" "}
                      {service.appointmentCount === 1
                        ? "appointment"
                        : "appointments"}
                    </span>
                  </button>

                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setEditor({ id: service.id, seen: updateState })
                      }
                    >
                      Edit
                    </Button>

                    <form action={deleteAction} className="flex gap-1">
                      <input type="hidden" name="id" value={service.id} />
                      {confirmingRemovalId === service.id ? (
                        <>
                          <SubmitButton
                            label="Confirm remove"
                            pendingLabel="Removing…"
                            variant="destructive"
                            size="sm"
                          />
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setRemoval({ id: null, seen: deleteState })
                            }
                          >
                            {/* "Cancel", not "Keep" — beside "Confirm remove",
                                a third verb reads as a third outcome. */}
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setRemoval({ id: service.id, seen: deleteState })
                          }
                        >
                          Remove
                        </Button>
                      )}
                    </form>
                  </div>
                </div>
              )}

              {/*
                Beside the row it is about, and it stays there until the next
                removal changes the state that produced it. Both messages this
                can carry — "N appointments use this service" and "keep at
                least one service" — describe work to do elsewhere, which §11.4
                says must be inline and persistent rather than a toast.
              */}
              {removalError ? (
                <div className="pb-4">
                  <Callout tone="warning" title="Cannot remove this service">
                    {removalError}
                  </Callout>
                </div>
              ) : null}
            </li>
          )
        })}

        {/*
          `deleteService` refuses to remove the last Service and onboarding
          seeds several, so this list cannot legitimately be empty. It is here
          so that if the seed ever fails, the section says so instead of
          rendering an unexplained gap.
        */}
        {services.length === 0 ? (
          <li className="border-b border-line py-3 text-table text-text-muted">
            No services yet — add the first one below.
          </li>
        ) : null}
      </ul>

      <form action={addAction} className="flex flex-col gap-3 pt-5">
        {/*
          Above the fields, because a form-level refusal is about the
          submission as a whole and belongs to neither input.
        */}
        {addState.errors?.form ? (
          <Callout tone="warning">{addState.errors.form}</Callout>
        ) : null}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <FieldLabel htmlFor={`${baseId}-add-name`}>
              Add a service
            </FieldLabel>
            <Input
              id={`${baseId}-add-name`}
              name="name"
              /*
                Repopulated from the rejected submission, exactly as
                `components/onboarding/onboarding-form.tsx` does: React resets
                the form once the action settles, and a `defaultValue` equal to
                what was sent is what makes that reset restore the typing
                instead of wiping it.
              */
              defaultValue={addState.values?.name}
              maxLength={MAX_SERVICE_NAME_LENGTH}
              autoComplete="off"
              placeholder="Beard trim"
              aria-invalid={Boolean(addState.errors?.name) || undefined}
              aria-describedby={
                addState.errors?.name ? `${baseId}-add-name-error` : undefined
              }
            />
          </div>

          <div className="flex flex-col gap-1.5 sm:w-28">
            <FieldLabel htmlFor={`${baseId}-add-duration`}>Minutes</FieldLabel>
            {/*
              No `min`, `max` or `step` attribute, deliberately. The bounds are
              enforced in `lib/settings/services-input.ts`, which has to check
              them anyway — a Server Action is a POST anyone can send. Adding
              them here would hand the same job to the browser's constraint
              validation, which blocks the submit and answers with a transient
              bubble; the carefully worded refusals ("Give the duration in whole
              minutes — 45, not 45.5") would then never be seen, and §11.4 asks
              for inline persistent messages rather than popups. `type="number"`
              stays for the numeric keypad on a phone.
            */}
            <Input
              id={`${baseId}-add-duration`}
              name="durationMinutes"
              type="number"
              inputMode="numeric"
              className="font-mono"
              defaultValue={addState.values?.durationMinutes}
              placeholder="30"
              aria-invalid={
                Boolean(addState.errors?.durationMinutes) || undefined
              }
              aria-describedby={
                addState.errors?.durationMinutes
                  ? `${baseId}-add-duration-error`
                  : undefined
              }
            />
          </div>
        </div>

        <FieldError
          id={`${baseId}-add-name-error`}
          message={addState.errors?.name}
        />
        <FieldError
          id={`${baseId}-add-duration-error`}
          message={addState.errors?.durationMinutes}
        />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-table text-text-muted">
            Anything from{" "}
            <span className="font-mono">{MIN_SERVICE_MINUTES} min</span> to{" "}
            <span className="font-mono">{MAX_SERVICE_MINUTES} min</span>.
            Changing one only affects bookings made from now on.
          </p>
          <div className="ml-auto flex items-center gap-3">
            <SavedNote token={addState.saved ? addState : null}>Added</SavedNote>
            <SubmitButton label="Add service" pendingLabel="Adding…" />
          </div>
        </div>
      </form>
    </section>
  )
}

/**
 * A submit button that knows whether its own form is in flight.
 *
 * A child of the form on purpose: `useFormStatus` reports the status of the
 * form *above* it, so read in the component that renders the form it is always
 * false. Here that placement earns something extra — every row renders its own
 * removal form, so each button reports only its own row's submit, and clicking
 * "Confirm remove" on one Service does not spin the button on five others.
 *
 * Not `ui/pending-submit-button.tsx`, for one reason: the row buttons are the
 * 28px `sm` size and that component is fixed at 32px. Worth folding together the
 * day it grows a size prop.
 */
function SubmitButton({
  label,
  pendingLabel,
  variant,
  size,
}: {
  label: string
  pendingLabel: string
  variant?: "default" | "destructive"
  size?: "default" | "sm"
}) {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" variant={variant} size={size} disabled={pending}>
      {/* On the button itself; §11.4 rules out a full-page blocker. */}
      {pending && <Loader2 className="animate-spin" aria-hidden />}
      {pending ? pendingLabel : label}
    </Button>
  )
}
