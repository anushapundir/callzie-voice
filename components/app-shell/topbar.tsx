"use client"

import type * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { ChevronRight } from "lucide-react"

import { usePageTitle } from "@/components/app-shell/page-title"
import { navTitle } from "@/lib/nav"

type TopbarProps = {
  /** The drawer trigger on the left, these two on the right. */
  mobileNav?: React.ReactNode
  liveIndicator?: React.ReactNode
  userButton?: React.ReactNode
}

/**
 * 64px of paper with no bottom border. The sidebar's vertical hairline is the
 * only rule the shell needs; a second one across the top boxed the page in.
 *
 * The title is the one large thing on the screen — 32px Instrument Serif, the
 * display voice of the system.
 */
export function Topbar({ mobileNav, liveIndicator, userButton }: TopbarProps) {
  const pathname = usePathname()
  const pageTitle = usePageTitle()

  /*
    `/calls/<id>` is the one screen that sits below the four destinations, and
    until now it had no way back to the list it came from — the title just said
    "Calls" and did nothing. The name comes from the page itself: a layout in
    the App Router only sees its own segment, so it cannot read the id, let
    alone who the call was to.
  */
  const onCallDetail = pathname.startsWith("/calls/")

  const title = (
    <h1 className="min-w-0 truncate font-serif text-title text-text">
      {onCallDetail ? (pageTitle ?? "Call") : navTitle(pathname)}
    </h1>
  )

  return (
    <header className="workspace-topbar sticky top-0 z-30 flex h-16 shrink-0 items-center bg-bg px-4 lg:px-8">
      {/* The same 1200px column as <main>, so the title sits over the content
          instead of hugging the left edge of a wide monitor. */}
      <div className="mx-auto flex w-full max-w-[1200px] items-center gap-3">
        {mobileNav}
        {onCallDetail ? (
          <nav
            aria-label="Breadcrumb"
            className="flex min-w-0 items-center gap-2"
          >
            {/* `min-h-11` on a coarse pointer is the 44px finger target. A
                pointer that cannot hover is a finger. */}
            <Link
              href="/calls"
              className="inline-flex shrink-0 items-center rounded-control text-table text-text-muted transition-colors hover:text-text pointer-coarse:min-h-11"
            >
              Calls
            </Link>
            <ChevronRight
              className="size-4 shrink-0 text-text-muted"
              strokeWidth={1.5}
              aria-hidden
            />
            {title}
          </nav>
        ) : (
          title
        )}
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {liveIndicator}
          {userButton}
        </div>
      </div>
    </header>
  )
}
