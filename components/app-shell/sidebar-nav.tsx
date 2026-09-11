"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

import { RailTooltip } from "@/components/app-shell/rail-tooltip"
import { NAV_ITEMS, isActiveNavItem } from "@/lib/nav"
import { cn } from "@/lib/utils"

type SidebarNavProps = {
  /**
   * When true the labels are hidden below `lg` and each item collapses to its
   * icon. The drawer passes false — it always has room.
   */
  collapsible?: boolean
  onNavigate?: () => void
}

export function SidebarNav({ collapsible = false, onNavigate }: SidebarNavProps) {
  const pathname = usePathname()

  return (
    <nav aria-label="Main" className="flex flex-col gap-1 px-3">
      {NAV_ITEMS.map((item) => {
        const active = isActiveNavItem(pathname, item.href)
        const Icon = item.icon

        return (
          <RailTooltip key={item.href} label={item.label} enabled={collapsible}>
            <Link
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                /*
                  `font-medium` on every item, active or not. Weight used to be
                  added on the active one only, so the word physically got wider
                  the moment you arrived and the whole list nudged sideways.

                  `pointer-coarse:h-11` is the 44px finger target. A pointer
                  that cannot hover is a finger, which is the drawer on a phone;
                  a mouse keeps the tighter 36px row.
                */
                "flex h-9 items-center gap-3 rounded-control text-body font-medium transition-colors pointer-coarse:h-11",
                // The active item is a fill of paper one shade down, not a
                // border colour. `line` is for hairlines between rows; using it
                // as a background made the active item look like a rule that
                // had swollen.
                active
                  ? "bg-surface-card text-text"
                  : "text-text-muted hover:bg-surface-soft hover:text-text",
                collapsible ? "justify-center lg:justify-start lg:px-3" : "px-3"
              )}
            >
              <Icon className="size-4 shrink-0" strokeWidth={1.5} aria-hidden />
              <span className={cn(collapsible && "hidden lg:inline")}>
                {item.label}
              </span>
            </Link>
          </RailTooltip>
        )
      })}
    </nav>
  )
}
