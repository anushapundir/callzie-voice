import { Skeleton } from "@/components/ui/skeleton";

/**
 * The shape of Clerk's sign-in/sign-up card, drawn in gray boxes. Shown in
 * two gaps: while the route itself loads (app/(auth)/loading.tsx) and while
 * Clerk's browser bundle downloads (the `fallback` prop on SignIn/SignUp).
 * Using one component for both means the card never visibly changes shape —
 * the skeleton just fills in.
 *
 * A skeleton rather than a spinner, per SPEC.md §11.4's "never a full-page
 * blocker": the layout holds still, so nothing jumps when the form lands.
 */
export function AuthCardSkeleton() {
  return (
    <div className="flex w-full max-w-100 flex-col gap-4">
      {/* Title and subtitle */}
      <div className="flex flex-col items-center gap-2">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-56" />
      </div>

      {/* The Google button */}
      <Skeleton className="mt-2 h-10" />

      {/* The "or" divider */}
      <div className="flex items-center gap-3">
        <Skeleton className="h-px flex-1" />
        <Skeleton className="size-4 rounded-full" />
        <Skeleton className="h-px flex-1" />
      </div>

      {/* Email field: label, input, submit */}
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-10" />
      </div>
      <Skeleton className="h-10" />

      {/* The "don't have an account?" footer line */}
      <Skeleton className="mx-auto mt-2 h-4 w-48" />
    </div>
  );
}
