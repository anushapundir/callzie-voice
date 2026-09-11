"use client"

import { Check, ChevronsUpDown } from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  normalizeTimeZone,
  offsetLabel,
  supportedTimeZones,
} from "@/lib/time/timezones"
import { cn } from "@/lib/utils"

/**
 * The IANA timezone picker, defaulting to the one the browser is already in.
 *
 * **The default can only be computed on the client.** `resolvedOptions()` on
 * Cloud Run reports UTC, so a server-rendered default would be wrong for every
 * user outside it. It is read in a lazy `useState` initialiser rather than an
 * effect so the correct zone is there on first paint — no flash of "UTC" that
 * silently becomes the real answer a moment later, which is the version a user
 * submits without noticing.
 *
 * The option list comes from the same module the Server Action validates with,
 * evaluated in this runtime. Browser and server ICU builds disagree about which
 * spelling of a renamed zone is canonical (`Asia/Calcutta` vs `Asia/Kolkata`),
 * which is exactly why validation resolves a zone rather than testing it for
 * membership — see `lib/time/timezones.ts`.
 */

/** How many rows to render at once. */
const VISIBLE_LIMIT = 50;

type TimezoneComboboxProps = {
  /** Field name in the submitted FormData. */
  name: string
  /** Put on the trigger, so a `<Label htmlFor>` focuses it. */
  id?: string
  defaultValue?: string
  invalid?: boolean
  describedBy?: string
}

/** `"Asia/Kolkata"` → `"asia kolkata"`, so a space-separated query matches. */
function searchable(zone: string): string {
  return zone.toLowerCase().replace(/[/_]/g, " ")
}

/**
 * `"America/New_York"` → `"America/New York"`.
 *
 * **For display only.** The underscore is part of the real IANA name — the
 * string the database stores and every `Intl` call resolves — so this must
 * never touch the value in the hidden input or the `value` cmdk matches on. It
 * changes the two text nodes a person reads and nothing else.
 */
function zoneLabel(zone: string): string {
  return zone.replace(/_/g, " ")
}

export function TimezoneCombobox({
  name,
  id,
  defaultValue,
  invalid,
  describedBy,
}: TimezoneComboboxProps) {
  const zones = supportedTimeZones()

  const [value, setValue] = React.useState(() => {
    // A rejected submit sends the previous choice back; otherwise ask the
    // browser. `normalizeTimeZone` guards against a zone this runtime cannot
    // resolve, which is possible on an unusual or very new build.
    const candidate =
      normalizeTimeZone(defaultValue) ??
      normalizeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone)
    return candidate ?? "UTC"
  })
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")

  // One instant for every offset label in a render, so the list cannot show two
  // zones' offsets measured a millisecond apart.
  const now = React.useMemo(() => new Date(), [])

  const matches = React.useMemo(() => {
    const needle = searchable(query.trim())
    const all = needle
      ? zones.filter((zone) => searchable(zone).includes(needle))
      : zones
    // cmdk would happily render all ~400 rows on open, which is visibly slow.
    // Filtering and slicing here also keeps `offsetLabel` — an
    // Intl.DateTimeFormat call each — to the rows actually on screen.
    return { shown: all.slice(0, VISIBLE_LIMIT), total: all.length }
  }, [query, zones])

  return (
    <>
      {/* What the Server Action reads. The combobox itself is a button. */}
      <input type="hidden" name={name} value={value} />

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            className="w-full justify-between font-normal"
          >
            <span className="truncate">{zoneLabel(value)}</span>
            <span className="flex shrink-0 items-center gap-2">
              <span className="font-mono text-table text-text-muted">
                {offsetLabel(value, now)}
              </span>
              <ChevronsUpDown className="size-4 text-text-muted" aria-hidden />
            </span>
          </Button>
        </PopoverTrigger>

        <PopoverContent
          align="start"
          // Match the trigger rather than a fixed width, so the panel cannot
          // overflow a 375px viewport (§11.4).
          className="w-(--radix-popover-trigger-width) p-0"
        >
          {/* Filtering is ours, not cmdk's — see `matches` above. */}
          <Command shouldFilter={false}>
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Search timezones"
            />
            <CommandList>
              <CommandEmpty>No timezone matches that.</CommandEmpty>
              {matches.shown.map((zone) => (
                <CommandItem
                  key={zone}
                  value={zone}
                  onSelect={() => {
                    setValue(zone)
                    setQuery("")
                    setOpen(false)
                  }}
                >
                  <Check
                    aria-hidden
                    className={cn(
                      "size-4 text-accent",
                      zone === value ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span className="truncate">{zoneLabel(zone)}</span>
                  <span className="ml-auto font-mono text-table text-text-muted">
                    {offsetLabel(zone, now)}
                  </span>
                </CommandItem>
              ))}
              {matches.total > matches.shown.length && (
                <p className="px-3 py-2 text-table text-text-muted">
                  {matches.total - matches.shown.length} more — keep typing to
                  narrow the list.
                </p>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </>
  )
}
