import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shown inside the onboarding shell while the screen loads: the header
 * stays put and the content area shows the shape of the setup form —
 * a title, a few labelled fields, and the submit button.
 */
export default function OnboardingLoading() {
  return (
    // 560px, the same column width as the form itself — a different one here
    // makes the page visibly jump the moment the real screen arrives.
    <div className="mx-auto flex w-full max-w-140 flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-72" />
      </div>

      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-10" />
        </div>
      ))}

      <Skeleton className="h-10 w-32" />
    </div>
  );
}
