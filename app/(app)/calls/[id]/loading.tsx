import { Skeleton } from "@/components/ui/skeleton"

/**
 * The call detail screen's loading state: the name, the facts line, the verdict,
 * then the two columns — player and transcript on the left, outcome and write-up
 * on the right.
 *
 * The same shape as the real page, at the same sizes, so nothing jumps when the
 * data lands. The transcript rows are full-width bars rather than the alternating
 * left and right blocks they used to be, because the transcript is no longer a
 * chat.
 */
export default function CallDetailLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <Skeleton className="h-9 w-1/3" />
        <Skeleton className="h-6 w-2/3" />
      </div>

      <Skeleton className="h-7 w-1/2" />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-6">
          <Skeleton className="h-8 rounded-card" />
          <div className="flex flex-col gap-3">
            <Skeleton className="h-12 rounded-card" />
            <Skeleton className="h-12 rounded-card" />
            <Skeleton className="h-12 rounded-card" />
          </div>
        </div>
        <div className="flex flex-col gap-6">
          <Skeleton className="h-56 rounded-card" />
          <Skeleton className="h-40 rounded-card" />
        </div>
      </div>
    </div>
  )
}
