"use client"

import * as React from "react"

import {
  rotateWidgetKeyAction,
  saveWidgetOriginsAction,
} from "@/app/(app)/settings/actions"
import { PendingSubmitButton } from "@/components/ui/pending-submit-button"
import { SettingsCallout, SettingsSection } from "@/components/settings/section"
import { FieldError } from "@/components/ui/field-error"
import { INITIAL_WIDGET_STATE } from "@/lib/settings/widget-state"

/**
 * The Talk-to-us widget (issue #45).
 *
 * **The origins field is the security control, not a convenience**, and the copy
 * says so rather than treating it as configuration. The key ships in HTML on a
 * public page — anybody can read it — so the list of sites is the only thing
 * that makes a stolen key useless.
 *
 * Two forms, for the same reason `inbound-section.tsx` has two: saving the sites
 * and rotating the key are separate decisions, and a shared state would surface
 * one's error under the other.
 *
 * The snippet is rendered from the key the action returns rather than from a
 * prop, so it appears the moment the first save succeeds. Before that there is
 * no key and nothing to paste.
 */
export function WidgetSection({
  appUrl,
  widgetKey,
  origins,
  dailyCap,
  inboundEnabled,
}: {
  /** The deployed origin. The snippet has to point somewhere real. */
  appUrl: string
  widgetKey: string | null
  origins: string[]
  dailyCap: number
  /**
   * Whether answering is on at all.
   *
   * The widget reaches the same Agent as a phone caller and is refused by the
   * same guard, so with this off every press of the button is a 403 the visitor
   * sees as "we can't take calls right now".
   *
   * Nothing stops a Business configuring the widget first — and it should not,
   * because the two are separate decisions. What was missing was saying so:
   * without the warning below you get a key, a snippet, and a button that
   * silently does nothing, with no screen in the product explaining why.
   */
  inboundEnabled: boolean
}): React.JSX.Element {
  const [saveState, saveOrigins] = React.useActionState(
    saveWidgetOriginsAction,
    INITIAL_WIDGET_STATE
  )
  const [rotateState, rotateKey] = React.useActionState(
    rotateWidgetKeyAction,
    INITIAL_WIDGET_STATE
  )

  /*
    The newest key wins: a rotation, then a save, then whatever the page loaded
    with. `undefined` means that form has not run, which is different from a
    `null` meaning "the widget was just switched off".
  */
  const currentKey =
    rotateState.key !== undefined
      ? rotateState.key
      : saveState.key !== undefined
        ? saveState.key
        : widgetKey

  const snippet =
    currentKey === null
      ? null
      : `<script src="${appUrl}/widget.js" data-callzie-key="${currentKey}"></script>`

  return (
    <SettingsSection
      title="Talk-to-us button"
      description="A button on your own website that opens a conversation with Maya. No phone number involved, and nothing for the visitor to install."
    >
      <div className="flex flex-col gap-5">
        {/*
          First, above everything, and only when it applies. Somebody arriving
          here to set the button up needs to know it cannot work yet before they
          paste anything — not after they have pasted it and watched it fail.
        */}
        {!inboundEnabled ? (
          <SettingsCallout tone="warning" title="Answering calls is off">
            The button will not work until you switch on{" "}
            <strong>Answering calls</strong> above — it reaches Maya the same way
            a phone caller does, so the same switch controls it. Until then
            visitors see &ldquo;we can&rsquo;t take calls right now&rdquo;.
          </SettingsCallout>
        ) : null}

        <form action={saveOrigins} className="flex flex-col gap-2">
          <label className="text-table font-medium text-text" htmlFor="origins">
            Which sites the button works on
          </label>
          <p className="text-table text-text-muted">
            One address per line. This is the part that matters: the key in the
            snippet below is public, and this list is what stops anyone else
            using it. Leave it empty to switch the button off.
          </p>
          <textarea
            aria-describedby={saveState.error ? "origins-error" : undefined}
            aria-invalid={Boolean(saveState.error) || undefined}
            className="w-full max-w-lg rounded-control border border-line bg-surface px-3 py-2 font-mono text-table text-text"
            defaultValue={origins.join("\n")}
            id="origins"
            name="origins"
            placeholder="https://example.com"
            rows={3}
          />
          <div>
            <PendingSubmitButton
              label="Save sites"
              pendingLabel="Saving…"
              variant="outline"
            />
          </div>
          <FieldError id="origins-error" message={saveState.error} />
        </form>

        {snippet ? (
          <div className="flex flex-col gap-2">
            <p className="text-table font-medium text-text">
              Paste this into your site
            </p>
            {/*
              A `pre`, and horizontally scrollable rather than wrapped. The
              snippet has to be copied exactly, and a soft-wrapped script tag is
              one somebody pastes with a line break in it.
            */}
            <pre className="max-w-full overflow-x-auto rounded-control border border-line bg-surface-soft p-3 font-mono text-table text-text-muted">
              {snippet}
            </pre>
            <p className="text-table text-text-muted">
              Anywhere before <span className="font-mono">&lt;/body&gt;</span>.
              The visitor is told they are speaking to an AI before their
              microphone is ever requested.
              {!inboundEnabled ? (
                <>
                  {" "}
                  <strong className="text-attention">
                    It will not do anything until answering calls is on.
                  </strong>
                </>
              ) : null}
            </p>
          </div>
        ) : (
          <SettingsCallout title="The button is off">
            Add at least one site above and Callzie will give you a snippet to
            paste.
          </SettingsCallout>
        )}

        <SettingsCallout title="Daily limit">
          At most{" "}
          <span className="font-mono tabular-nums">{dailyCap}</span> calls a day
          from the website, on top of your inbound allowance. Whichever runs out
          first stops the button — so a bad day on the web cannot spend what you
          were keeping for the phone.
        </SettingsCallout>

        {currentKey ? (
          <form action={rotateKey} className="flex flex-col gap-2">
            <p className="text-table text-text-muted">
              If the snippet ended up somewhere it should not be, issue a new
              key. The old one stops working immediately, and you will need to
              update the snippet on every site.
            </p>
            {/* Named, so a POST without this form does nothing. */}
            <input type="hidden" name="confirm" value="rotate" />
            <div>
              <PendingSubmitButton
                label="Issue a new key"
                pendingLabel="Issuing…"
                variant="destructive"
              />
            </div>
            <FieldError id="rotate-error" message={rotateState.error} />
          </form>
        ) : null}
      </div>
    </SettingsSection>
  )
}
