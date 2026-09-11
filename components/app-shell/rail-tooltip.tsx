import type * as React from "react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/**
 * Names a control that has lost its label to the collapsed icon rail. The
 * tooltip is suppressed at `lg`, where the label is visible again and the
 * tooltip would only repeat it.
 */
export function RailTooltip({
  label,
  enabled,
  children,
}: {
  label: string
  enabled: boolean
  children: React.ReactElement
}) {
  if (!enabled) return children

  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" className="lg:hidden">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
