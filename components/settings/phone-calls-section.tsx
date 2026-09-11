import type * as React from "react"

import { setPhoneCallsEnabledAction } from "@/app/(app)/settings/actions"
import { PendingSubmitButton } from "@/components/ui/pending-submit-button"
import { SettingsCallout, SettingsSection } from "@/components/settings/section"

/**
 * The Phone Call switch (SPEC.md §3 rule 9, §14 rule 6, issue #19).
 *
 * **This must never render for a non-admin.** The gate is `businesses.is_admin`
 * on the page, and it is not re-checked here — one owner of an authorisation
 * decision, the same argument `env-status-section.tsx` makes. The write itself
 * is separately scoped to admins inside its own UPDATE, so a form posted
 * without the page still writes nothing.
 *
 * A form and a button rather than a live switch, matching
 * `google-calendar-section.tsx`. It keeps the section a Server Component and
 * gets a per-button spinner from `PendingSubmitButton` for nothing — SPEC.md
 * §11.4 wants a loading state on the button, not a full-page blocker.
 *
 * The section renders two things beyond the button, and both are load-bearing.
 * It says what turning this on means, in the plainest words available, because
 * the flag is the difference between a demo and a robocaller. And it says when
 * the flag will not help — before the switch is flipped, not after. A blank
 * `RETELL_FROM_NUMBER` is a real state, and finding out by placing a Call that
 * gets refused is a worse way to learn it; finding out by flipping the switch
 * and reading the warning that appears is the same mistake one step earlier.
 *
 * The costs quoted below come from `docs/verification.md` A2's 120-second
 * table: ~$0.50 for a Phone Call to India against ~$0.15 for a Web Call. Note
 * what that table does **not** say — A2's "10×" is India telephony against US
 * telephony ($0.15 vs $0.015), phone against phone, and has nothing to do with
 * phone against browser. This is the screen someone reads while deciding
 * whether to flip the most dangerous flag in the product, so the number has to
 * be the right one.
 */
export function PhoneCallsSection({
  enabled,
  fromNumberSet,
}: {
  enabled: boolean
  /** Whether `RETELL_FROM_NUMBER` is set. A boolean — never the value. */
  fromNumberSet: boolean
}): React.JSX.Element {
  return (
    <SettingsSection
      title="Phone calls"
      description="Whether Maya calls a customer's phone instead of running in this browser. Off for every account by default."
    >
      <div className="flex flex-col gap-5">
        {enabled ? (
          <SettingsCallout tone="warning" title="Phone calls are on">
            Every &ldquo;Call now&rdquo; on this account dials the number on the
            appointment, except for the demo numbers the seeded appointments
            carry — those are refused rather than dialled. A call to a real
            phone costs around $0.50 where a browser call costs around $0.15,
            and both count against the same quota.
          </SettingsCallout>
        ) : (
          <SettingsCallout title="Phone calls are off">
            &ldquo;Call now&rdquo; runs the conversation in this browser. Nothing
            on this account can dial a phone.
          </SettingsCallout>
        )}

        {/*
          Shown whether or not the flag is on, deliberately. Gating this on
          `enabled` would put the warning after the click that caused it: the
          person sees nothing, turns phone calls on, and only then reads that
          nothing can dial. The point of the message is to be read first.
        */}
        {!fromNumberSet ? (
          <SettingsCallout
            tone="warning"
            title="No outbound number is configured"
          >
            <span className="font-mono">RETELL_FROM_NUMBER</span> is not set on
            this deployment.{" "}
            {enabled
              ? "Every phone call is refused before it is placed."
              : "Turning phone calls on will not make anything dial — every call would be refused before it is placed."}{" "}
            No quota is spent when that happens.
          </SettingsCallout>
        ) : null}

        <form action={setPhoneCallsEnabledAction}>
          {/*
            The value named, not inferred. A form submitted twice from a stale
            render must land where it said, rather than flipping whatever it
            finds.
          */}
          <input type="hidden" name="enabled" value={enabled ? "off" : "on"} />
          {/*
            `outline` for turning on, not the accent. §11.2 gives the accent to
            primary actions and turning on is the primary action here, so this
            is the palette rule deliberately not applied: the accent is an
            invitation, and this is the one click in the product that lets it
            dial strangers and spend real money. Nothing about it should be
            inviting. Turning off keeps `destructive` — red for the switch that
            is currently live, which is the state a person is more likely to
            need to leave in a hurry.

            The focus ring is unaffected either way: `app/globals.css` puts a
            2px accent outline on every `:focus-visible` element, so no button
            variant can lose it (§11.4).
          */}
          <PendingSubmitButton
            label={enabled ? "Turn off phone calls" : "Turn on phone calls"}
            pendingLabel={enabled ? "Turning off…" : "Turning on…"}
            variant={enabled ? "destructive" : "outline"}
          />
        </form>
      </div>
    </SettingsSection>
  )
}
