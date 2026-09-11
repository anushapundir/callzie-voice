"use client"

import { useActionState } from "react"

import { completeOnboarding } from "@/app/(onboarding)/onboarding/actions"
import { BusinessTypePicker } from "@/components/business-type-picker"
import { TimezoneCombobox } from "@/components/onboarding/timezone-combobox"
import { Callout } from "@/components/ui/callout"
import { FieldError } from "@/components/ui/field-error"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PendingSubmitButton } from "@/components/ui/pending-submit-button"
import type { OnboardingFormState } from "@/components/onboarding/state"
import { INITIAL_ONBOARDING_STATE, MAX_BUSINESS_NAME_LENGTH } from "@/lib/onboarding/input"

/**
 * The whole of onboarding: one screen, three fields (SPEC.md §11.3).
 *
 * One column on plain paper — no card around it, and no card around each field
 * either. It used to be a card containing four cards, which is the "box inside
 * a box" docs/design.md rules out. A section here is a run of rows with a rule
 * between them.
 *
 * Errors render inline and persist rather than as a toast — §11.4 reserves
 * toasts for transient results and requires "inline persistent UI for anything
 * requiring action". A rejected submit also repopulates from `state.values`, so
 * a blank name does not cost someone their Business Type and timezone choices.
 */
export function OnboardingForm() {
  /*
    The state type is named explicitly because the initial value has no
    `formError` on it. Without the annotation TypeScript infers the state from
    that initial value, decides `formError` does not exist, and the one error a
    person actually sees on a bad day stops compiling.
  */
  const [state, formAction] = useActionState<OnboardingFormState, FormData>(
    completeOnboarding,
    INITIAL_ONBOARDING_STATE
  )

  return (
    <form action={formAction} className="onboarding-form mx-auto w-full max-w-140">
      <p className="font-mono text-table tracking-[0.06em] text-text-muted uppercase">
        A little introduction
      </p>
      {/*
        The page title is also the radio group's label — see `labelledBy`
        below. That is why the fieldset and its legend are gone: a legend
        reading "Business type" directly under a heading asking the same
        question was the same words twice, once for the eye and once for a
        screen reader.
      */}
      <h1
        id="businessType-label"
        className="mt-3 font-serif text-[40px] leading-[1.05] tracking-[-0.02em] text-text"
      >
        What kind of business is this?
      </h1>
      <p className="mt-3 text-body text-text-muted">
        We&apos;ll set up your hours, services and a few example appointments so
        you can see it working right away.
      </p>

      <div className="mt-8">
        <BusinessTypePicker
          name="businessType"
          labelledBy="businessType-label"
          defaultValue={state.values?.businessType}
          invalid={Boolean(state.errors?.businessType)}
          describedBy={
            state.errors?.businessType ? "businessType-error" : undefined
          }
        />
        <div className="mt-2">
          <FieldError
            id="businessType-error"
            message={state.errors?.businessType}
          />
        </div>
      </div>

      {/*
        The one heavier rule on the screen. It says "the choice above is the
        question; what follows is detail" — the same job the rule under a
        section title does everywhere else in the app.
      */}
      <div className="mt-8 flex flex-col gap-6 border-t border-line-strong pt-8">
        <div className="flex flex-col gap-2">
          <Label htmlFor="name">Business name</Label>
          <Input
            id="name"
            name="name"
            defaultValue={state.values?.name}
            maxLength={MAX_BUSINESS_NAME_LENGTH}
            autoComplete="organization"
            placeholder="Your business name"
            aria-invalid={Boolean(state.errors?.name) || undefined}
            aria-describedby={state.errors?.name ? "name-error" : undefined}
          />
          <FieldError id="name-error" message={state.errors?.name} />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="timezone-trigger">Timezone</Label>
          <TimezoneCombobox
            name="timezone"
            id="timezone-trigger"
            defaultValue={state.values?.timezone}
            invalid={Boolean(state.errors?.timezone)}
            describedBy={state.errors?.timezone ? "timezone-error" : undefined}
          />
          <p className="text-table text-text-muted">
            Your opening hours and appointment times are shown in this timezone.
          </p>
          <FieldError id="timezone-error" message={state.errors?.timezone} />
        </div>
      </div>

      {/*
        Something failed on the server — the database was unreachable, or the
        seed could not be written. Before this, that threw and the person got
        Next's default error page, losing everything they had just typed. Now
        the form stays exactly as it was and says what happened.
      */}
      {state.formError ? (
        <Callout tone="warning" className="mt-8" title="We couldn't set that up">
          {state.formError}
        </Callout>
      ) : null}

      <div className="mt-8">
        <PendingSubmitButton
          label="Open my dashboard"
          pendingLabel="Setting up…"
        />
      </div>
    </form>
  )
}
