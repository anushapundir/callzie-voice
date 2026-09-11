import { UserButtonSlot } from "@/components/app-shell/user-button-slot";
import { Wordmark } from "@/components/brand/wordmark";

/**
 * The Onboarding shell — deliberately not the app shell (ADR-0006).
 *
 * No sidebar and no topbar: every item in that nav needs a Business to mean
 * anything, and the Quota meter would have no row to read. SPEC.md §11.3 asks
 * for one screen, so this is one screen.
 *
 * The user button is the one piece of chrome kept. Without it, an account that
 * cannot finish onboarding — a browser whose timezone this deployment refuses,
 * say — has no way to sign out and no way back to anything.
 */
export default function OnboardingLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="onboarding-shell flex min-h-svh flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-line px-4 lg:px-6">
        {/*
          The one drawing of the logo, same as every other screen. This header
          used to draw its own — a monospace C in a bordered box — which made
          three different logos on the way from the landing page to here.
          No `href`: there is nowhere to go until the Business exists.
        */}
        <Wordmark size="md" />
        {/*
          Wrapped, not bare. Clerk renders its own `cl-rootBox` around the
          button and that box stretches to fill a flex parent, which put the
          avatar hard against the wordmark instead of at the right edge.
          `components/app-shell/topbar.tsx` wraps it the same way.
        */}
        <div className="flex shrink-0 items-center">
          <UserButtonSlot />
        </div>
      </header>

      <main className="flex flex-1 items-start justify-center px-4 py-10 lg:px-6">
        {children}
      </main>
    </div>
  );
}
