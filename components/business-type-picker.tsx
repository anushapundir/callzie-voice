"use client"

import { RadioGroup } from "radix-ui"
import * as React from "react"

import { BUSINESS_TYPES } from "@/lib/db/schema"
import { TEMPLATES } from "@/lib/onboarding/templates"
import { cn } from "@/lib/utils"

/**
 * The four Business Type tiles (SPEC.md §11.3).
 *
 * A radio group semantically — one choice, arrow-key navigation, a single Tab
 * stop — but rendered as tiles, because the issue asks for four options that
 * are "visibly distinct rather than a radio list".
 *
 * Built on Radix rather than the usual `sr-only` native-input trick for one
 * concrete reason: `app/globals.css` puts a single global `:focus-visible`
 * outline on every focusable element, and a visually hidden input would draw
 * that outline on a zero-size box where nobody can see it — forcing a
 * `peer-focus-visible:` workaround that the same stylesheet explicitly says
 * components must not have. With Radix the tile *is* the focusable element, so
 * the global rule lands on the thing the eye is already on.
 *
 * The cost is that this screen needs JavaScript. Accepted: the timezone
 * combobox cannot work without it either, since only the browser knows which
 * timezone the person is in.
 *
 * A tile carries a name and one sentence. No icon, and no preview of the prompt
 * behind it — a user never authors a Template, they pick one (SPEC.md §14
 * rule 5).
 */

type BusinessTypePickerProps = {
  name: string
  /**
   * Id of the visible label — the group's own name, not a duplicate of it.
   *
   * Optional, because `compact` has no visible label to point at. When it is
   * absent the group names itself with `aria-label` instead; a radio group
   * with neither is a group a screen reader announces as nothing at all.
   */
  labelledBy?: string
  defaultValue?: string
  invalid?: boolean
  describedBy?: string
  /**
   * Drops the one-sentence description under each name and tightens the grid.
   *
   * Settings re-uses this picker to change a Business Type that is already
   * chosen. There the four options are being compared, not explained — the
   * person already knows which one they run — and the descriptions turn a
   * two-line answer into a paragraph. Everything else, including all of the
   * radio-group semantics, is identical in both modes.
   */
  compact?: boolean
}

export function BusinessTypePicker({
  name,
  labelledBy,
  defaultValue,
  invalid,
  describedBy,
  compact = false,
}: BusinessTypePickerProps) {
  /*
    Controlled, and carried into FormData by our own hidden input rather than
    the one Radix bubbles for `name`.

    Both details exist because of one bug. React resets the enclosing `<form>`
    once an action completes; Radix sees that reset and clears its value and its
    bubbled input. So a rejected submit wiped the chosen Business Type while the
    name and timezone survived — and restoring only the visible state made it
    worse, because the bubbled input stayed unchecked: the tile looked selected
    and the next submit still failed with "Choose a business type", with nothing
    on screen to explain why.

    Two things fix it. A hidden input driven by React state cannot drift from
    what is displayed, because one `selected` renders both — the pattern
    `timezone-combobox.tsx` already uses, and the timezone field is exactly the
    one that survived this bug untouched. And the reset arrives as
    `onValueChange("")`, which is ignored below: a radio group has no legitimate
    transition back to "nothing selected", so an empty value is only ever the
    reset talking.
  */
  const [selected, setSelected] = React.useState(defaultValue ?? "")

  return (
    <>
      <input type="hidden" name={name} value={selected} />

      <RadioGroup.Root
        value={selected}
        // Ignores the empty value React's post-action form reset sends; a user
        // cannot un-pick a radio, so "" is never a real choice.
        onValueChange={(value) => {
          if (value) setSelected(value)
        }}
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : "Business type"}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        /*
          The whole grid is drawn with one colour and one pixel. The container
          is `line`-coloured, each tile paints itself back to paper, and the
          1px gaps between them are the container showing through — so the
          hairlines between tiles are exactly 1px and can never double up the
          way four separately-bordered tiles would where they meet.
        */
        className="workspace-business-picker grid grid-cols-2"
      >
        {BUSINESS_TYPES.map((businessType) => {
          const template = TEMPLATES[businessType]

          return (
            <RadioGroup.Item
              key={businessType}
              value={businessType}
              className={cn(
                // Square corners, no radius: these are cells in a grid, not
                // four cards floating on paper.
                "group flex flex-col items-start bg-surface text-left transition-colors",
                compact ? "gap-1 p-3" : "gap-2 p-4",
                "hover:bg-surface-soft",
                /*
                  The selected tile is the one filled surface on this screen:
                  ink fill, paper text. Fill rather than a border plus a check
                  mark, which is what this used to be — a fill survives a
                  greyscale screenshot better than either, and it means the
                  answer to "which did I pick?" is visible from across the room
                  rather than needing the 16px tick to be found first.
                */
                "data-[state=checked]:bg-accent data-[state=checked]:text-bg",
                "data-[state=checked]:hover:bg-accent-active"
              )}
            >
              <span
                // `text-page` is the 22px token and carries its own weight —
                // adding `font-medium` here is the thing docs/design.md names
                // as how one heading shipped at two different weights.
                className="text-page text-text group-data-[state=checked]:text-bg"
              >
                {template.label}
              </span>
              {compact ? null : (
                <span className="text-table text-text-muted group-data-[state=checked]:text-bg/70">
                  {template.description}
                </span>
              )}
            </RadioGroup.Item>
          )
        })}
      </RadioGroup.Root>
    </>
  )
}
