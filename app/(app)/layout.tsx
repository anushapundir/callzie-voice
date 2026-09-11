import { LiveIndicator } from "@/components/app-shell/live-indicator"
import { MobileNav } from "@/components/app-shell/mobile-nav"
import { PageTitleProvider } from "@/components/app-shell/page-title"
import { Sidebar } from "@/components/app-shell/sidebar"
import { Topbar } from "@/components/app-shell/topbar"
import { UserButtonSlot } from "@/components/app-shell/user-button-slot"
import { LiveCallBar } from "@/components/calls/live-call-bar"
import { LiveCallProvider } from "@/components/calls/live-call-provider"
import { countActiveCalls } from "@/lib/business/active-calls"
import { requireBusiness } from "@/lib/business/require-business"
import { businessQuota } from "@/lib/quota"

export default async function AppLayout({ children }: LayoutProps<"/">) {
  /*
    The provisioning point and the onboarding gate, in that order: this layout
    wraps every app route, so the first authenticated request an account makes
    passes through here — which is what "a users row is created on first
    sign-in" means with no Clerk webhook — and an account that has no Business
    yet is redirected to Onboarding from wherever it asked for.

    A blocking `await`, not a `<Suspense>` boundary. ADR-0005 anticipated moving
    it once the shell rendered from the row; ADR-0006 records why the answer
    turned out to be no. Briefly: a redirect cannot be streamed, so flushing the
    shell first would show an un-onboarded account a sidebar and an empty
    Overview before throwing it to /onboarding — the exact blank state this
    ticket exists to prevent. `currentBusiness` is React-`cache()`d, so the page
    below pays nothing for reading it again.
  */
  const { business } = await requireBusiness()
  const quota = businessQuota(business)

  /*
    The real count, replacing the hardcoded 1 that stood here while there was
    nothing to read. `in_progress` and recent — see lib/business/active-calls.ts
    for why "recent" is half the definition.
  */
  const activeCalls = await countActiveCalls(business.id)

  /*
    The provider wraps the shell rather than sitting inside a page, because a
    Call outlives the screen it was started from and both surfaces that start
    one need to reach the same state. `children` is passed through as a prop, so
    every page below stays a Server Component.
  */
  return (
    <LiveCallProvider phoneCallsEnabled={business.phoneCallsEnabled}>
      <PageTitleProvider>
        {/*
          `data-app-shell` is the handle the live indicator reaches for. When a
          call is in progress it puts `data-live="true"` here, and everything
          that reacts to a live call — the topbar dot, the row wash — hangs off
          this one attribute rather than each part being told separately.
        */}
        <div data-app-shell className="flex min-h-svh">
          {/*
            The first focusable thing on the page. Without it a keyboard user
            tabs through the whole sidebar before reaching the content, on every
            screen. It is parked above the viewport and slides in on focus —
            `translate` rather than `sr-only`, so there is no chance of a
            positioning rule landing in the wrong order and leaving it visible.
          */}
          <a
            href="#main"
            className="absolute top-3 left-3 z-50 -translate-y-20 rounded-control border border-line bg-surface px-3 py-2 text-body text-text shadow-overlay transition-transform focus:translate-y-0"
          >
            Skip to content
          </a>

          {/* Drawer below `md`, icon rail to `lg`, 240px above it. The
              `border-r` is the sidebar's only chrome. */}
          <Sidebar
            quota={quota}
            businessName={business.name}
            collapsible
            className="hidden shrink-0 border-r border-line md:sticky md:top-0 md:flex md:h-svh md:w-16 lg:w-60"
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <Topbar
              mobileNav={
                <MobileNav quota={quota} businessName={business.name} />
              }
              liveIndicator={<LiveIndicator activeCalls={activeCalls} />}
              userButton={<UserButtonSlot />}
            />
            {/* Under the topbar, above the content: never covers the table, which
                is what SPEC.md §16 step 5 depends on. */}
            <LiveCallBar />
            {/*
              A measured column, not the full width of the monitor. Text set
              across 2000px is unreadable, and every screen used to run to the
              edge of whatever display it was opened on.

              `tabIndex={-1}` is what makes the skip link actually move focus:
              without it some browsers scroll here and leave focus where it was,
              so the next Tab goes back into the sidebar.
            */}
            <main
              id="main"
              tabIndex={-1}
              className="workspace-content mx-auto w-full max-w-[1200px] flex-1 px-4 py-6 lg:px-8"
            >
              {children}
            </main>
          </div>
        </div>
      </PageTitleProvider>
    </LiveCallProvider>
  )
}
