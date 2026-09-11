"use client"

import * as React from "react"
import { Command as CommandPrimitive } from "cmdk"
import { SearchIcon } from "lucide-react"

import { cn } from "@/lib/utils"

/*
  cmdk's filterable list, restyled onto SPEC.md §11.2 and trimmed to the five
  parts the timezone combobox uses.

  Two deliberate departures from what `shadcn add command` generates:

  - **No `CommandDialog`, no `InputGroup`.** They were the only reason this
    pulled in `dialog.tsx`, `input-group.tsx` and — through that —
    `textarea.tsx`. Nothing here uses a command palette, and a Textarea
    primitive is the one component SPEC.md §14 rule 5 says this product must
    never offer, so carrying an unused one invites exactly the wrong edit.
    `CommandInput` renders its own field instead.
  - **No auto-rendered check icon on `CommandItem`.** The default hangs one off
    `data-[checked=true]`; the combobox draws its own so the selected state is
    explicit at the call site.

  Every size, radius and colour below is a token. The shadcn defaults
  (`rounded-xl!`, `text-sm`, `rounded-sm`, `text-xs`) are not, and because
  `--radius-*` / `--text-*` are reset to `initial` they emit no CSS at all
  rather than failing the build.
*/

function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        "flex size-full flex-col overflow-hidden bg-surface text-text",
        className
      )}
      {...props}
    />
  )
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div
      data-slot="command-input-wrapper"
      className="flex items-center gap-2 border-b border-line px-3"
    >
      <SearchIcon className="size-4 shrink-0 text-text-muted" aria-hidden />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "h-9 w-full bg-transparent text-body text-text placeholder:text-text-muted disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
    </div>
  )
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        "max-h-64 scroll-py-1 overflow-x-hidden overflow-y-auto p-1",
        className
      )}
      {...props}
    />
  )
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn("px-3 py-6 text-center text-table text-text-muted", className)}
      {...props}
    />
  )
}

function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-control px-2 py-1.5 text-body text-text select-none",
        // `muted` is the hover/selection wash — §11.2 reserves the accent for
        // primary actions, the live indicator and the waveform.
        "data-selected:bg-muted data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    />
  )
}

export { Command, CommandEmpty, CommandInput, CommandItem, CommandList }
