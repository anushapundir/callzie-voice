"use client"

import Link from "next/link"
import * as React from "react"

import { Wordmark } from "@/components/brand/wordmark"
import { SIGN_IN_URL, SIGN_UP_URL } from "@/lib/auth/routes"
import { cn } from "@/lib/utils"

import { LinkPending } from "./link-pending"

/*
  The landing page's header. A client component for one reason: the phone
  menu's open/closed state. Everything else here is links.

  It inherits its colours from the landing page, so the navigation
  and the story below share the same palette.

  "Sign in" goes to the themed screen in app/(auth), not the hosted portal —
  the same SIGN_IN_URL constant the proxy and the root layout use, so the three
  can never disagree about where sign-in lives.
*/

const LINKS = [
  { label: "How it works", href: "#how-it-works" },
  { label: "The story", href: "#what-you-get" },
  { label: "Sign in", href: SIGN_IN_URL },
] as const

export function MarketingNavbar() {
  const [open, setOpen] = React.useState(false)

  /*
    While the menu is open: lock page scroll, close on Escape, and close if the
    viewport grows back to desktop width, where the menu is not a thing. All
    three undo themselves when the menu closes.
  */
  React.useEffect(() => {
    if (!open) return
    document.body.style.overflow = "hidden"
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    const desktop = window.matchMedia("(min-width: 768px)")
    const onResize = () => {
      if (desktop.matches) setOpen(false)
    }
    window.addEventListener("keydown", onKey)
    desktop.addEventListener("change", onResize)
    return () => {
      document.body.style.overflow = ""
      window.removeEventListener("keydown", onKey)
      desktop.removeEventListener("change", onResize)
    }
  }, [open])

  const close = () => setOpen(false)

  return (
    <header className="relative z-20 mx-auto flex w-full max-w-[1140px] items-center justify-between gap-6 px-5 py-5 md:px-8">
      <Link
        href="/"
        aria-label="Callzie"
        className="rounded-control text-[24px] text-text"
      >
        <Wordmark size="inherit" />
      </Link>

      <nav aria-label="Primary" className="hidden items-center gap-8 md:flex">
        {LINKS.map((link) => (
          <NavLink key={link.label} href={link.href} onClick={close}>
            {link.label}
          </NavLink>
        ))}
        <PillButton href={SIGN_UP_URL}>Get started</PillButton>
      </nav>

      {/* Phone: one 44px control, and the sheet it opens. */}
      <button
        type="button"
        aria-controls="site-nav"
        aria-expanded={open}
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((current) => !current)}
        className="-mr-2 flex size-11 items-center justify-center rounded-full text-text md:hidden"
      >
        <span className="relative block h-3 w-5">
          <span
            className={cn(
              "absolute inset-x-0 top-0 h-0.5 rounded-full bg-current transition-transform duration-200",
              open && "top-1/2 rotate-45"
            )}
          />
          <span
            className={cn(
              "absolute inset-x-0 top-1/2 h-0.5 rounded-full bg-current transition-opacity duration-200",
              open && "opacity-0"
            )}
          />
          <span
            className={cn(
              "absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-current transition-transform duration-200",
              open && "bottom-1/2 -rotate-45"
            )}
          />
        </span>
      </button>

      <nav
        id="site-nav"
        aria-label="Primary"
        hidden={!open}
        className="absolute inset-x-4 top-full z-30 flex flex-col gap-1 rounded-soft border border-line bg-surface p-4 shadow-soft md:hidden"
      >
        {LINKS.map((link) => (
          <NavLink
            key={link.label}
            href={link.href}
            onClick={close}
            className="flex h-11 items-center"
          >
            {link.label}
          </NavLink>
        ))}
        <PillButton href={SIGN_UP_URL} className="mt-2 h-11" onClick={close}>
          Get started
        </PillButton>
      </nav>
    </header>
  )
}

/** A nav item is a word. The affordance is the colour going to full ink. */
function NavLink({
  href,
  children,
  onClick,
  className,
}: {
  href: string
  children: React.ReactNode
  onClick?: () => void
  className?: string
}) {
  const base =
    "text-body font-medium text-text-muted transition-colors hover:text-text"

  if (href.startsWith("#")) {
    return (
      <a href={href} onClick={onClick} className={cn(base, className)}>
        {children}
      </a>
    )
  }

  return (
    <Link
      href={href}
      onClick={onClick}
      className={cn("relative overflow-hidden rounded-control", base, className)}
    >
      {children}
      <LinkPending />
    </Link>
  )
}

/**
 * The filled button: ink, and a full pill.
 *
 * One shape for every call to action on the page. A pill rather than the app's
 * 4px control, because this page is a poster and the app is a form — and the
 * difference is most of what makes the front door feel softer than the desk.
 */
export function PillButton({
  href,
  children,
  className,
  onClick,
  size = "sm",
}: {
  href: string
  children: React.ReactNode
  className?: string
  onClick?: () => void
  size?: "sm" | "lg"
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-accent font-medium text-bg transition-colors hover:bg-accent-active",
        size === "sm" ? "h-10 px-5 text-body" : "h-13 px-7 text-section",
        className
      )}
    >
      {children}
      <LinkPending />
    </Link>
  )
}

/** Its quiet twin: a hairline pill, for the second action in a pair. */
export function GhostPill({
  href,
  children,
  className,
  size = "sm",
}: {
  href: string
  children: React.ReactNode
  className?: string
  size?: "sm" | "lg"
}) {
  return (
    <a
      href={href}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full border border-line bg-surface font-medium text-text transition-colors hover:bg-surface-soft",
        size === "sm" ? "h-10 px-5 text-body" : "h-13 px-7 text-section",
        className
      )}
    >
      {children}
    </a>
  )
}
