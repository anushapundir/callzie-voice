import { Infinity as InfinityIcon } from "lucide-react"
import type * as React from "react"

import { SettingsSection } from "@/components/settings/section"
import { Progress } from "@/components/ui/progress"
import { quotaPercentUsed, type Quota } from "@/lib/quota"

/**
 * The Quota, as Settings shows it (SPEC.md §11.3).
 *
 * The same number the sidebar meter carries, on the screen someone opens when
 * they want to know why a Call was refused — so it reads identically to
 * `components/app-shell/quota-meter.tsx`: the counts in mono, the same "N of M
 * calls used" sentence, the same fill thresholds, and the accent kept out of the
 * bar (§11.2 reserves it for primary actions, the live indicator and the
 * waveform).
 *
 * That similarity is copied rather than imported, and deliberately.
 * `QuotaMeter` is the sidebar *footer* — it renders its own top border and rail
 * padding and collapses to a bare bar under `lg`, none of which belongs inside a
 * Settings card. Pulling the shared bar out into a third component is a change
 * to a file this task does not own; the duplication is two class names and a
 * sentence, and it is visible in a diff.
 *
 * A Server Component: nothing here is interactive, so this section costs the
 * page no JavaScript beyond the `Progress` primitive itself.
 */

export function QuotaSection({ quota }: { quota: Quota }): React.JSX.Element {
  const { callsUsed, callQuota } = quota
  const percent = quotaPercentUsed(quota)

  /*
    `callQuota: null` is an admin account — `lib/quota.ts` translates
    `is_admin` into it precisely because SPEC.md §11.1 renders that case as
    "Unlimited". No meter goes with it: a proportion of unlimited has no value
    to show, and a bar at 0% would read as "none used" on an account that may
    have placed hundreds of Calls.
  */
  if (callQuota === null) {
    return (
      <SettingsSection
        title="Call quota"
        description="How many calls this account may place."
      >
        <p className="flex items-center gap-2 text-body text-text">
          <InfinityIcon className="size-4 shrink-0 text-text-muted" aria-hidden />
          Unlimited
        </p>
      </SettingsSection>
    )
  }

  const label = `${callsUsed} of ${callQuota} calls used`

  // Fills toward attention, then declined, as the Quota runs down — matching
  // the sidebar meter exactly, since the two are the same fact.
  const fill =
    percent >= 100
      ? "bg-declined"
      : percent >= 80
        ? "bg-attention"
        : "bg-text-muted"

  return (
    <SettingsSection
      title="Call quota"
      description="How many calls this account may place."
    >
      <div className="flex max-w-96 flex-col gap-2">
        <p className="text-body text-text-muted">
          {/* Mono on the numbers only (§11.2): they are the values someone
              compares across visits, and the prose around them is not. */}
          <span className="font-mono text-text">{callsUsed}</span> of{" "}
          <span className="font-mono text-text">{callQuota}</span> calls used
        </p>
        {/*
          `aria-label` carries the same sentence, because the bar's own
          `aria-valuenow` is a percentage and "80" is not what a screen reader
          user is being told above it.
        */}
        <Progress
          value={percent}
          indicatorClassName={fill}
          aria-label={label}
          className="bg-line"
        />
      </div>
    </SettingsSection>
  )
}
