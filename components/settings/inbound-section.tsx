"use client"

import * as React from "react"

import {
  setEmergencyLineAction,
  setInboundEnabledAction,
} from "@/app/(app)/settings/actions"
import { PendingSubmitButton } from "@/components/ui/pending-submit-button"
import { SettingsCallout, SettingsSection } from "@/components/settings/section"
import { FieldError } from "@/components/ui/field-error"
import { INITIAL_INBOUND_STATE } from "@/lib/settings/inbound-state"

/**
 * Whether Maya answers the phone, and the number she gives in an emergency
 * (issue #43).
 *
 * Unlike `phone-calls-section.tsx` this is not admin-gated, and the difference
 * is worth stating. Arbitrary outbound dialling on an open-signup product is a
 * robocaller (SPEC.md §3 rule 9). Answering a number the business already owns
 * is not — the cost is bounded by the inbound quota, the caller chose to ring,
 * and the risk is bounded by the emergency number below.
 *
 * **The emergency number comes first on the screen and first in the flow**,
 * because the switch cannot be turned on without it. That ordering is the
 * design: somebody arriving here reads what Maya will say to a person in
 * trouble before they read anything about answering calls at all.
 *
 * Two forms rather than one. Saving a number and switching answering on are
 * separate decisions, and a single form would make changing the number look
 * like it might also change the switch.
 */
export function InboundSection({
  enabled,
  emergencyLine,
  quota,
  used,
  numbers,
}: {
  enabled: boolean
  emergencyLine: string | null
  quota: number
  used: number
  /** The numbers pointed at this Business. Read-only — see below. */
  numbers: { id: string; e164: string }[]
}): React.JSX.Element {
  const hasEmergencyLine = emergencyLine !== null && emergencyLine !== ""

  /*
    Two `useActionState` calls, not one. Saving the number and flipping the
    switch are separate decisions, and a shared state would let the number's
    validation error surface under the switch — the same reasoning
    `services-section.tsx` gives for keeping its three apart.
  */
  const [numberState, saveNumber] = React.useActionState(
    setEmergencyLineAction,
    INITIAL_INBOUND_STATE
  )
  const [switchState, toggleAnswering] = React.useActionState(
    setInboundEnabledAction,
    INITIAL_INBOUND_STATE
  )

  return (
    <SettingsSection
      title="Answering calls"
      description="Whether Maya picks up when somebody rings this business. She answers around the clock — being closed changes what she says, not whether she answers."
    >
      <div className="flex flex-col gap-5">
        {/*
          First, and shown whether or not answering is on. The switch below
          refuses without it, so reading about it afterwards would mean reading
          an error instead of an explanation.
        */}
        <form action={saveNumber} className="flex flex-col gap-2">
          <label
            className="text-table font-medium text-text"
            htmlFor="emergency_line"
          >
            Emergency number
          </label>
          <p className="text-table text-text-muted">
            If a caller says they are in pain, in danger, or describes an
            emergency, Maya gives them this number and ends the call. She never
            offers advice. Answering cannot be switched on without it.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              aria-describedby={
                numberState.error ? "emergency_line-error" : undefined
              }
              aria-invalid={Boolean(numberState.error) || undefined}
              className="w-64 rounded-control border border-line bg-surface px-3 py-2 font-mono text-table text-text"
              defaultValue={emergencyLine ?? ""}
              id="emergency_line"
              name="emergency_line"
              placeholder="+1 202 555 0111"
              type="tel"
            />
            <PendingSubmitButton
              label="Save number"
              pendingLabel="Saving…"
              variant="outline"
            />
          </div>
          <FieldError id="emergency_line-error" message={numberState.error} />
        </form>

        {enabled ? (
          <SettingsCallout tone="warning" title="Maya is answering this line">
            Callers reach Maya instead of a voicemail. She can answer questions
            about your services and hours, book people into open slots, and
            write down anything she could not handle. She never quotes a price
            and never takes payment details.
          </SettingsCallout>
        ) : (
          <SettingsCallout title="Maya is not answering">
            Nothing on this account picks up an incoming call.
          </SettingsCallout>
        )}

        {/*
          The quota, stated where the decision is made. Inbound volume is not
          something the account controls, so running out is a real prospect and
          it is the account's own customers who hear the consequence.
        */}
        <SettingsCallout title="Inbound allowance">
          <span className="font-mono tabular-nums">
            {used} of {quota}
          </span>{" "}
          incoming calls answered. Once the allowance is spent, calls are
          declined rather than answered — so raise it before it runs out.
        </SettingsCallout>

        {/*
          Read-only, and there is no "buy a number" button anywhere in the
          product. Callzie is open signup, and a self-serve control that starts
          a recurring $2/month line is the same class of risk as arbitrary
          outbound dialling (SPEC.md §3 rule 9). Provisioning is an operator
          action: `npm run provision-number`.

          Shown here anyway because this is the number the business has to
          forward their real line to, and they need to be able to read it.
        */}
        {numbers.length > 0 ? (
          <SettingsCallout title="Your Callzie number">
            <span className="font-mono tabular-nums">
              {numbers.map((n) => n.e164).join(", ")}
            </span>{" "}
            Forward your published number to this one and Maya picks up. Your own
            number does not change.
          </SettingsCallout>
        ) : enabled ? (
          <SettingsCallout tone="warning" title="No number is pointed here yet">
            Maya is switched on but no phone number reaches her, so nothing can
            ring. A number has to be provisioned before this does anything.
          </SettingsCallout>
        ) : null}

        <form action={toggleAnswering}>
          {/* The value named, not inferred — see phone-calls-section.tsx. */}
          <input type="hidden" name="enabled" value={enabled ? "off" : "on"} />
          <PendingSubmitButton
            /*
              Disabled without an emergency number rather than allowed to fail.
              The action refuses either way and says why, but a button that
              cannot work should look like it — and the label right above it
              has just explained the reason.
            */
            disabled={!enabled && !hasEmergencyLine}
            label={enabled ? "Stop answering calls" : "Start answering calls"}
            pendingLabel={enabled ? "Turning off…" : "Turning on…"}
            variant={enabled ? "destructive" : "outline"}
          />
          <FieldError id="inbound-error" message={switchState.error} />
        </form>
      </div>
    </SettingsSection>
  )
}
