import { Skeleton } from "@/components/ui/skeleton"

/**
 * The Schedule screen's loading state: the day controls, the big date, then the
 * tall day grid. Same layout as the real page, so nothing jumps when the data
 * lands — including the 32px date heading, which is the largest thing on the
 * screen and the most obvious jump if it were missing here.
 */
export default function ScheduleLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <Skeleton className="h-8 w-16" />
        <Skeleton className="h-8 w-12" />
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-9 w-64" />
      </div>
      <Skeleton className="h-120" />
    </div>
  )
}
