"use client"

import * as React from "react"

/**
 * Lets a page tell the topbar what to call it.
 *
 * The topbar lives in `app/(app)/layout.tsx`, and a layout in the App Router
 * only ever sees its own segment — it cannot read `/calls/[id]`'s id, let alone
 * the name of the person that Call was to. So the page hands the name up
 * through this instead of the topbar trying to fetch it a second time.
 *
 * Nothing breaks if a page says nothing: the topbar falls back to a plain
 * word.
 */
const PageTitleContext = React.createContext<{
  title: string | null
  setTitle: (title: string | null) => void
} | null>(null)

export function PageTitleProvider({ children }: { children: React.ReactNode }) {
  const [title, setTitle] = React.useState<string | null>(null)
  const value = React.useMemo(() => ({ title, setTitle }), [title])

  return (
    <PageTitleContext.Provider value={value}>
      {children}
    </PageTitleContext.Provider>
  )
}

/** What the current page calls itself, or null if it has not said. */
export function usePageTitle(): string | null {
  return React.useContext(PageTitleContext)?.title ?? null
}

/**
 * Render this anywhere inside a page to name it in the topbar. It draws
 * nothing.
 *
 * The name is cleared on unmount, so navigating away cannot leave the last
 * page's name in the bar while the next one loads.
 */
export function SetPageTitle({ title }: { title: string }) {
  const setTitle = React.useContext(PageTitleContext)?.setTitle

  React.useEffect(() => {
    setTitle?.(title)
    return () => setTitle?.(null)
  }, [setTitle, title])

  return null
}
