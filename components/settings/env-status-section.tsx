import type * as React from "react"

import { SettingsCallout, SettingsSection } from "@/components/settings/section"
import type { EnvGroup, EnvVarStatus } from "@/lib/settings/env-status"
import { cn } from "@/lib/utils"

/**
 * The configuration panel (SPEC.md §11.3, "env status").
 *
 * It exists so that "the calls stopped going out" can be answered as
 * "ANTHROPIC_API_KEY is blank on the deployed service" without shelling into a
 * container — every secret lives in the environment (SPEC.md §3 rule 1), which
 * makes a missing one both the likeliest cause of a dead feature and the least
 * visible from inside the product.
 *
 * **This must never render for a non-admin.** The gate is
 * `businesses.is_admin` on the page, and it is not re-checked here — one owner
 * of an authorisation decision is the point. But Callzie is open signup (SPEC.md
 * §14 rule 9), so anyone can hold an account, and everything below is
 * reconnaissance for one of them: which provider a deployment is wired to, and
 * which credential is currently absent. A future caller adding this section to
 * an ungated page is the failure mode this paragraph is here to prevent.
 *
 * It renders booleans and nothing else — no value, no prefix, no length, no
 * masked rendering. `lib/settings/env-status.ts` refuses to put a secret in the
 * return type at all, and the guarantee only holds while the UI wants nothing
 * more than that.
 *
 * **Missing is not one colour.** A required variable that is unset is the
 * declined red: something is broken. An optional one is the muted `unreachable`
 * grey and says "optional" in the label, because per ADR-0004 an unset Google
 * variable is an ordinary, fully-functional deployment — red rows that mean
 * nothing are how people learn to ignore red rows.
 *
 * A Server Component. Nothing here is interactive.
 */

type Section = { group: EnvGroup; variables: EnvVarStatus[] }

/**
 * Groups without sorting.
 *
 * The order is `.env.example`'s, fixed in the catalogue so that a variable added
 * to one file and forgotten in the other shows up as a diff between two short
 * lists. Re-ordering here — alphabetically, or by whether something is missing —
 * would break that correspondence and move rows around under someone comparing
 * two deployments side by side. Groups appear in the order they are first seen;
 * a group split across the catalogue still collapses into one heading.
 */
function groupVariables(variables: EnvVarStatus[]): Section[] {
  const sections: Section[] = []

  for (const variable of variables) {
    const section = sections.find((candidate) => candidate.group === variable.group)
    if (section) {
      section.variables.push(variable)
    } else {
      sections.push({ group: variable.group, variables: [variable] })
    }
  }

  return sections
}

export function EnvStatusSection({
  variables,
}: {
  variables: EnvVarStatus[]
}): React.JSX.Element {
  const sections = groupVariables(variables)
  const missingRequired = variables.filter(
    (variable) => variable.required && !variable.set
  ).length

  return (
    <SettingsSection
      title="Configuration"
      description="Which environment variables this deployment has. Values are never shown — only whether something is set."
    >
      <div className="flex flex-col gap-5">
        {/*
          The summary a person actually came for, above the list rather than
          buried in it: with twelve rows on screen, one red pill in the middle
          is easy to scroll past. Persistent and inline, because it names
          something that has to be fixed on the deployment (§11.4).
        */}
        {missingRequired > 0 ? (
          <SettingsCallout
            tone="warning"
            title={
              missingRequired === 1
                ? "1 required variable is not set"
                : `${missingRequired} required variables are not set`
            }
          >
            Whatever depends on them will fail until they are set on the deployed
            service and it restarts.
          </SettingsCallout>
        ) : null}

        {sections.map((section) => (
          <div key={section.group} className="flex flex-col gap-1">
            <h3 className="text-table font-medium text-text-muted">
              {section.group}
            </h3>
            <ul className="rounded-card border border-line">
              {section.variables.map((variable) => (
                <li
                  key={variable.name}
                  className="flex items-center justify-between gap-3 border-b border-line px-3 py-2 last:border-b-0"
                >
                  {/* Mono and wrapping: these are strings someone is about to
                      retype into a deploy config, and the longest of them
                      overflows the card at 375px. */}
                  <span className="font-mono text-table break-all text-text">
                    {variable.name}
                  </span>
                  <StatusPill set={variable.set} required={variable.required} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </SettingsSection>
  )
}

/**
 * Set / Missing, as a §11.2 dot-and-label pill.
 *
 * The label carries the whole meaning on its own, so the colour is confirmation
 * rather than the signal — the row still reads correctly in greyscale, and to
 * anyone who cannot separate the red from the grey.
 */
function StatusPill({
  set,
  required,
}: {
  set: boolean
  required: boolean
}): React.JSX.Element {
  const label = set ? "Set" : required ? "Missing" : "Not set — optional"
  const tone = set
    ? "border-confirmed/40 text-confirmed"
    : required
      ? "border-declined/40 text-declined"
      : "border-unreachable/40 text-unreachable"

  return (
    <span
      className={cn(
        // 4px grid throughout (§11.2) — no fractional spacing steps.
        "inline-flex shrink-0 items-center gap-2 rounded-full border px-2 py-1 text-table whitespace-nowrap",
        tone
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-2 rounded-full",
          set
            ? "bg-confirmed"
            : required
              ? "bg-declined"
              : "bg-unreachable"
        )}
      />
      {label}
    </span>
  )
}
