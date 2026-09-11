"use client"

import { Check, Copy } from "lucide-react"
import * as React from "react"

import { Button } from "@/components/ui/button"

/** How long the button keeps saying what happened before going back to "Copy". */
const RESULT_MS = 2000

/**
 * A value that has to be reproduced exactly, with a button that does it for you.
 *
 * Two things on this screen are read in order to be retyped somewhere else: the
 * snippet that goes into someone's website, and the number they forward their
 * phone line to. Both used to be muted grey with no way to copy them, so the
 * only route was a hand-made selection — and a snippet selected by hand picks up
 * a stray space or drops the last `>` about as often as not.
 *
 * So: ink on `surface-card`, which is the ground docs/design.md gives to code,
 * and a copy button beside it. Horizontally scrollable rather than wrapped,
 * because a soft-wrapped script tag is one somebody pastes with a line break
 * in the middle of it.
 */
export function CopyField({
  value,
  label,
}: {
  value: string
  /** What the button copies, for a screen reader: "Copy the snippet". */
  label: string
}) {
  return (
    <div className="flex items-start gap-2 rounded-control bg-surface-card px-3 py-2">
      <pre className="min-w-0 flex-1 overflow-x-auto py-1 font-mono text-table text-text">
        {value}
      </pre>
      <CopyButton value={value} label={label} />
    </div>
  )
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [result, setResult] = React.useState<"idle" | "copied" | "failed">(
    "idle"
  )

  React.useEffect(() => {
    if (result === "idle") return
    const timer = setTimeout(() => setResult("idle"), RESULT_MS)
    return () => clearTimeout(timer)
  }, [result])

  return (
    <Button
      /*
        `type="button"`. This sits inside the widget form, and a button in a form
        with no type submits it — which here would mean copying the snippet also
        saved the sites.
      */
      type="button"
      variant="ghost"
      size="sm"
      className="shrink-0"
      aria-label={label}
      onClick={() => {
        /*
          The clipboard is not always available: a browser only grants it on a
          secure origin, and it can refuse outright. An unhandled rejection here
          would be a red error in the console and nothing at all on screen, so
          the refusal is caught and said out loud instead. The text stays
          selectable either way.
        */
        navigator.clipboard
          .writeText(value)
          .then(() => setResult("copied"))
          .catch(() => setResult("failed"))
      }}
    >
      {result === "copied" ? <Check aria-hidden /> : <Copy aria-hidden />}
      {result === "copied"
        ? "Copied"
        : result === "failed"
          ? "Could not copy"
          : "Copy"}
    </Button>
  )
}
