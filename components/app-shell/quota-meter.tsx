import { Infinity as InfinityIcon } from "lucide-react"

import { RailTooltip } from "@/components/app-shell/rail-tooltip"
import { Callout } from "@/components/ui/callout"
import { Progress } from "@/components/ui/progress"
import { quotaPercentUsed, type Quota } from "@/lib/quota"
import { cn } from "@/lib/utils"

type QuotaMeterProps = {
  quota: Quota
  /** Matches SidebarNav — collapses to the bar alone below `lg`. */
  collapsible?: boolean
}

/**
 * How many calls are left, at the foot of the sidebar.
 *
 * Three things are fixed here.
 *
 * The figures are Inter 500, not mono. JetBrains Mono slashes its zero, so
 * "0 of 5 calls used" read as "Ø of 5" — a person with nothing left saw a
 * symbol instead of a number.
 *
 * The bar's track is `surface-card` with a hairline drawn as a ring. It used to
 * be the `line` token on a tinted sidebar, which is the same colour as the
 * sidebar, so an empty meter was invisible.
 *
 * And running out is no longer a dead end: the block always says who raises the
 * quota, and says it as a warning once there is nothing left.
 */
export function QuotaMeter({ quota, collapsible = false }: QuotaMeterProps) {
  const { callsUsed, callQuota } = quota
  const unlimited = callQuota === null
  const percent = quotaPercentUsed(quota)
  const label = unlimited ? "Unlimited" : `${callsUsed} of ${callQuota} calls used`
  const exhausted = !unlimited && percent >= 100

  // Fills toward attention, then declined, as the quota runs down. The one
  // colour in this system means "a call is live"; it stays out of the meter.
  const fill =
    percent >= 100
      ? "bg-declined"
      : percent >= 80
        ? "bg-attention"
        : "bg-text-muted"

  /*
    Words are dropped on the collapsed rail. It is 64px wide — a sentence does
    not fit, and the tooltip on the bar carries the count there instead.
  */
  const wide = collapsible && "hidden lg:block"

  if (unlimited) {
    return (
      <div className="px-3 py-4">
        <p className="flex items-center gap-2 text-table text-text-muted">
          <InfinityIcon className="size-4 shrink-0" aria-hidden />
          <span className={cn(collapsible && "hidden lg:inline")}>Unlimited</span>
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 px-3 py-4">
      <p className={cn("text-table text-text-muted", wide)}>
        <span className="font-medium text-text">{callsUsed}</span> of{" "}
        <span className="font-medium text-text">{callQuota}</span> calls used
      </p>

      <RailTooltip label={label} enabled={collapsible}>
        <div className="w-full">
          {/*
            A 2px bar. The hairline is a ring rather than a border: a border
            would be counted inside the 2px — boxes here measure border-box —
            and leave no height at all for the fill.

            `aria-label` repeats the sentence above because the bar's own
            `aria-valuenow` is a percentage, and "80" is not what the reader is
            being told.
          */}
          <Progress
            value={percent}
            indicatorClassName={fill}
            aria-label={label}
            className="h-1.5 rounded-full bg-surface-card"
          />
        </div>
      </RailTooltip>

      {exhausted ? (
        <Callout tone="warning" className={cn("p-3", wide)}>
          Every call on this account is used up. Ask the Callzie team to raise
          your quota and calling starts again.
        </Callout>
      ) : (
        <p className={cn("text-table text-text-muted", wide)}>
          Ask the Callzie team to raise it.
        </p>
      )}
    </div>
  )
}
