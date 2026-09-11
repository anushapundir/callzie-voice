import type * as React from "react"

import { Label } from "@/components/ui/label"
import { PageHeader } from "@/components/ui/page-header"
import { cn } from "@/lib/utils"

/**
 * The two pieces of chrome every Settings section shares.
 *
 * Settings used to be nine cards stacked down a 1150px page, each drawing its
 * own border and its own heading. It is now one 720px column of chapters: a
 * group heading, then sections that are a `PageHeader` and their fields
 * directly on the paper. No section is a box — see docs/design.md, "a section is
 * a run of rows separated by hairlines, not a box".
 *
 * Both exports are Server Components, so a section that needs no interactivity
 * (Google, quota, the admin panels) still ships no JavaScript for its frame.
 * Anything with a timer or a click handler lives in its own `"use client"` file
 * beside this one, for that reason.
 */

/**
 * One of the five headings the screen is grouped under — Business, Maya,
 * Integrations, Account, Admin.
 *
 * An eyebrow, not a title: uppercase 13px in muted grey, the same treatment
 * table headers get. That is deliberate, so it never competes with the
 * `text-section` titles of the sections underneath it.
 */
export function SettingsGroup({
  title,
  note,
  children,
}: {
  title: string
  /** One line under the heading. The Admin group uses it to say who sees it. */
  note?: string
  children: React.ReactNode
}) {
  return (
    <section id={title.toLowerCase()} className="workspace-settings-group">
      <div>
        <h2>
          {title}
        </h2>
        {note ? <p className="mt-1 text-table text-text-muted">{note}</p> : null}
      </div>
      {children}
    </section>
  )
}

/**
 * The label above a field: 13px, muted, the same on every form on this screen.
 *
 * Three different input labels used to ship here — a bare `<label>` with its own
 * classes in two sections and the shared `Label` in a third — which is how the
 * same form ended up with two type sizes. Everything else about it comes from
 * `components/ui/label.tsx`, including the `htmlFor` wiring a screen reader
 * needs.
 */
export function FieldLabel({
  className,
  ...props
}: React.ComponentProps<typeof Label>) {
  return <Label className={cn("text-table text-text-muted", className)} {...props} />
}

/**
 * One section: its title, its one-line description, then its fields.
 *
 * The name survives from when this really was a card. It is not one any more —
 * it is a `PageHeader` and the fields directly on the paper, which is why the
 * markup below has no border and no padding of its own. Keeping the name meant
 * the ten sections that import it did not each have to be edited in a UI
 * ticket, and none of them can accidentally keep the old chrome.
 */
export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string
  description?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="workspace-settings-section flex flex-col gap-5">
      <PageHeader title={title} description={description} />
      {children}
    </section>
  )
}

/**
 * Settings' name for the shared callout.
 *
 * The implementation lives in components/ui/callout.tsx, because the Call
 * detail screen needs the same amber for a failed extraction and a failed call.
 * Reserved for warnings: a static fact belongs in a key/value row, not in a box
 * the colour of a problem.
 */
export { Callout as SettingsCallout } from "@/components/ui/callout"
