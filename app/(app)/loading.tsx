import { Skeleton } from "@/components/ui/skeleton"

/**
 * The app group's loading state: while any screen's server data loads, the
 * shell (sidebar, topbar) stays put and the content area shows the shape of
 * what is coming — stat tiles, the three-card row, a table. It is drawn from
 * Overview because that is the screen most navigations land on; on the other
 * screens it reads as a generic page skeleton, which is all it needs to be.
 *
 * A skeleton rather than a spinner, per SPEC.md §11.4's "never a full-page
 * blocker": the page keeps its layout, so nothing jumps when the data lands.
 */
export default function AppLoading() {
  return (
    <div className="flex flex-col gap-8">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-20 rounded-card" />
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Skeleton className="hidden h-90 rounded-card lg:block" />
        <Skeleton className="h-90 rounded-card" />
        <Skeleton className="hidden h-90 rounded-card lg:block" />
      </div>

      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-1/3" />
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-12" />
        ))}
      </div>
    </div>
  )
}
