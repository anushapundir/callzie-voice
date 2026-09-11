"use client"

import { Loader2 } from "lucide-react"
import * as React from "react"

import { changeBusinessTypeAction } from "@/app/(app)/settings/actions"
import { BusinessTypePicker } from "@/components/business-type-picker"
import {
  SettingsCallout,
  SettingsSection,
} from "@/components/settings/section"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field-error"
import type { BusinessType } from "@/lib/db/schema"
import { INITIAL_BUSINESS_TYPE_STATE } from "@/lib/settings/business-type-input"

/**
 * Changing the Business Type from Settings — "changeable, no data migration"
 * (SPEC.md §11.3).
 *
 * Reuses the Onboarding picker rather than a select, because this is the same
 * choice made a second time and the four cards are the only place the Templates
 * describe themselves. Nothing here forks it: `components/business-type-picker.tsx`
 * already survives React's post-action form reset, which is the one bug this
 * form would otherwise reintroduce.
 *
 * **Why the save is two steps.** A Business Type is not a label — it selects the
 * Template and therefore the `retell_agents` row, so it decides which Agent
 * conducts every Call from here on (`lib/settings/business-type.ts`). A single
 * mis-aimed click on a card would otherwise re-point a working account at
 * another Agent with no moment to catch it. The confirm is React state and
 * renders inline: `window.confirm` and every other browser modal are ruled out
 * by §11.4's "never a full-page blocker", and a native dialog cannot carry the
 * paragraph below, which is the entire reason the step exists.
 *
 * **The copy is the feature.** Four cards captioned "salon / clinic / …" look
 * destructive — as if picking a new one re-seeds the account the way Onboarding
 * did. It does not: the change is one `UPDATE` to one column, and no
 * Appointment, Service or opening hour is migrated, deleted or re-created. Say
 * that plainly, or people will not touch the control at all.
 */

export function BusinessTypeSection({
  businessType,
}: {
  businessType: BusinessType
}): React.JSX.Element {
  const [state, formAction, pending] = React.useActionState(
    changeBusinessTypeAction,
    INITIAL_BUSINESS_TYPE_STATE
  )
  const [confirming, setConfirming] = React.useState(false)

  /*
    The confirm collapses as part of the submit, not after it.

    Collapsing in an effect keyed on `state.saved` would fire once and then
    never again — `saved` stays true across every later save, so the second
    change would leave "Confirm change" on screen having already run. Doing it
    in the action wrapper is unconditional and ordered: React has built the
    FormData before it calls this, so resetting state here cannot cost the
    submission a field.

    Wrapping the dispatch is also why the pending flag comes from
    `useActionState` rather than `useFormStatus`: `useFormStatus` reports on the
    function the form was given, and this one returns the moment it has
    dispatched, so it would flash rather than stay pending for the round trip.
  */
  function save(formData: FormData): void {
    setConfirming(false)
    formAction(formData)
  }

  return (
    <SettingsSection
      title="Business type"
      description="Your business type decides which agent runs your calls — how it introduces itself and how it talks about what you do."
    >
      <form action={save} className="flex flex-col gap-5">
        <fieldset className="flex flex-col gap-2">
          <legend
            id="settings-business-type-label"
            className="mb-2 text-body font-medium text-text"
          >
            What kind of business do you run?
          </legend>
          {/*
            `defaultValue` is the type as the server rendered it; the picker owns
            the value from the first click and carries it in its own hidden
            input, so a rejected save cannot leave the cards and the submitted
            value disagreeing.
          */}
          <BusinessTypePicker
            name="businessType"
            labelledBy="settings-business-type-label"
            defaultValue={businessType}
            invalid={Boolean(state.errors?.businessType)}
            describedBy={
              state.errors?.businessType
                ? "settings-business-type-error"
                : undefined
            }
          />
          <FieldError
            id="settings-business-type-error"
            message={state.errors?.businessType}
          />
        </fieldset>

        {/*
          The confirmation of the *last* save, hidden the moment another one is
          being considered — leaving "Business type saved" above a live "Confirm
          change" button would read as though the pending change had already
          landed.
        */}
        {state.saved && !confirming ? (
          <SettingsCallout tone="success" title="Business type saved">
            Calls from now on use this type&apos;s agent. Your appointments,
            services and opening hours were not touched.
          </SettingsCallout>
        ) : null}

        {confirming ? (
          <div className="flex flex-col gap-3">
            <SettingsCallout title="Change the agent that runs your calls?">
              Nothing is migrated, deleted or re-created: your appointments,
              services and opening hours stay exactly as they are, and no
              example data is seeded a second time. The only change is which
              agent conducts calls placed from now on.
            </SettingsCallout>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={pending}>
                {/* §11.4: the loading state lives on the button that started
                    the work, never on a page-wide blocker. */}
                {pending && <Loader2 className="animate-spin" aria-hidden />}
                {pending ? "Saving…" : "Confirm change"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            {/*
              `type="button"`: this opens the confirm, it does not submit. An
              unqualified button inside a form defaults to submit, which would
              be the whole two-step gate undone by an omitted attribute.
            */}
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirming(true)}
            >
              Change business type
            </Button>
            <p className="text-table text-text-muted">
              Pick a type above, then confirm the change.
            </p>
          </div>
        )}
      </form>
    </SettingsSection>
  )
}
