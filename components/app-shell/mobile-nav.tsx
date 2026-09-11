"use client"

import * as React from "react"
import { Menu } from "lucide-react"

import { Sidebar } from "@/components/app-shell/sidebar"
import type { Quota } from "@/lib/quota"
import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"

/**
 * The sidebar as a drawer, below `md`. Controlled so that following a link
 * closes it — an open drawer over the page you just navigated to is the classic
 * mobile-nav bug.
 */
export function MobileNav({
  quota,
  businessName,
}: {
  quota: Quota
  businessName: string
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        {/* 44px. This is a phone-only control, so it is always a finger. */}
        <Button variant="ghost" size="icon-sm" className="size-11 md:hidden">
          <Menu aria-hidden strokeWidth={1.5} />
          <span className="sr-only">Open navigation</span>
        </Button>
      </SheetTrigger>
      {/*
        The width must be written as `data-[side=left]:w-60`: SheetContent's own
        `data-[side=left]:w-3/4` carries an attribute selector, so a bare `w-60`
        loses on specificity and the drawer silently renders at 75% instead of
        240px.

        The close button comes from the Sheet primitive at 28px, which is too
        small for a thumb. It is sized up from here rather than in
        `components/ui/sheet.tsx`, because that file is shared with every other
        sheet in the app and most of them are not phone-only.
      */}
      <SheetContent
        side="left"
        className="gap-0 p-0 data-[side=left]:w-60 [&_[data-slot=sheet-close]]:size-11"
      >
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <SheetDescription className="sr-only">
          Move between Overview, Calls, Schedule and Settings.
        </SheetDescription>
        <Sidebar
          quota={quota}
          businessName={businessName}
          onNavigate={() => setOpen(false)}
        />
      </SheetContent>
    </Sheet>
  )
}
