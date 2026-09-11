import {
  CalendarDays,
  LayoutDashboard,
  PhoneCall,
  Settings,
  type LucideIcon,
} from "lucide-react"

/**
 * The app shell's four destinations (SPEC.md §11.1). Order here is the order
 * they render in the sidebar and the drawer.
 */
export type NavItem = {
  href: string
  label: string
  icon: LucideIcon
}

export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/calls", label: "Calls", icon: PhoneCall },
  { href: "/schedule", label: "Schedule", icon: CalendarDays },
  { href: "/settings", label: "Settings", icon: Settings },
] as const

/**
 * Overview owns only the exact root; every other item owns its subtree, so
 * `/calls/[id]` keeps Calls lit while you read a Call detail.
 */
export function isActiveNavItem(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/"
  return pathname === href || pathname.startsWith(`${href}/`)
}

/** The topbar's page title for a pathname. */
export function navTitle(pathname: string): string {
  const match = NAV_ITEMS.find((item) => isActiveNavItem(pathname, item.href))
  return match?.label ?? "Callzie"
}
