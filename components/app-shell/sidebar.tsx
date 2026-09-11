import Link from "next/link"
import Image from "next/image"
import { ArrowUpRight } from "lucide-react"

import { QuotaMeter } from "@/components/app-shell/quota-meter"
import { SidebarNav } from "@/components/app-shell/sidebar-nav"
import { Wordmark, WordmarkGlyph } from "@/components/brand/wordmark"
import type { Quota } from "@/lib/quota"
import { cn } from "@/lib/utils"

type SidebarProps = {
  quota: Quota
  /**
   * The business you are working in. After onboarding this name appeared
   * nowhere in the app, so an owner with two accounts had no way to tell which
   * one they were looking at.
   */
  businessName: string
  /** Rail below `lg`, full 240px at `lg` and up. The drawer passes false. */
  collapsible?: boolean
  onNavigate?: () => void
  className?: string
}

/**
 * The sidebar is a margin, not a panel.
 *
 * Same paper as the page, and one vertical hairline on the right — which the
 * caller draws with `border-r`. It used to be filled with `surface-soft`, which
 * made it a second surface stuck to the side of the sheet, and hid the quota
 * bar's track along with it.
 */
export function Sidebar({
  quota,
  businessName,
  collapsible = false,
  onNavigate,
  className,
}: SidebarProps) {
  return (
    <div className={cn("workspace-sidebar flex h-full flex-col bg-bg", className)}>
      <Brand
        collapsible={collapsible}
        businessName={businessName}
        onNavigate={onNavigate}
      />
      <SidebarNav collapsible={collapsible} onNavigate={onNavigate} />
      <div className="mt-auto">
        <div className={cn("workspace-maya", collapsible && "hidden lg:block")}>
          <Image src="/maya-avatar.png" alt="Maya" width={38} height={38} />
          <p>A little help from Maya.</p>
          <span>Set her up to sound like your business.</span>
          <Link href="/settings#maya" onClick={onNavigate}>Meet your assistant <ArrowUpRight size={13} aria-hidden /></Link>
        </div>
        <QuotaMeter quota={quota} collapsible={collapsible} />
      </div>
    </div>
  )
}

function Brand({
  collapsible,
  businessName,
  onNavigate,
}: {
  collapsible: boolean
  businessName: string
  onNavigate?: () => void
}) {
  return (
    /*
      The close-the-drawer handler sits on this wrapper rather than on the mark.
      `brand/wordmark.tsx` is the one drawing of the logo in the repo and it
      takes no `onClick`; a click on the link inside bubbles up to here, which
      is all the drawer needs to shut itself after you follow the link.
    */
    <div
      onClick={onNavigate}
      className={cn(
        "workspace-brand flex shrink-0 flex-col py-5",
        collapsible ? "items-center px-2 lg:items-start lg:px-3" : "px-3"
      )}
    >
      {collapsible ? (
        // The collapsed rail: one serif letter and nothing around it. The old
        // rail drew a bordered box with a monospace C in it, which read as a
        // button you could press.
        <Link
          href="/"
          aria-label="Callzie, back to overview"
          className="rounded-control lg:hidden"
        >
          <WordmarkGlyph />
        </Link>
      ) : null}
      <div className={cn("flex flex-col gap-1", collapsible && "hidden lg:flex")}>
        <Wordmark size="sm" href="/" />
        <p className="truncate text-table text-text-muted">{businessName}</p>
      </div>
    </div>
  )
}
