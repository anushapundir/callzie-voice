"use client"

import { AttentionPanel } from "@/components/overview/attention-panel"
import { useCsvUpload } from "@/components/overview/csv-upload"
import { Button } from "@/components/ui/button"
import { INITIAL_CSV_UPLOAD_STATE } from "@/lib/appointments/csv-input"

/**
 * What the last CSV upload created, and every row it refused (issue #8).
 *
 * **The refused rows are folded away behind a count.** A forty-row file with a
 * bad date format produces forty near-identical complaints, and forty of those
 * stacked above the Quick call card push the whole screen off the bottom. The
 * headline is the number; the list is one click away in a native `<details>`,
 * which costs no JavaScript and opens with the keyboard on its own.
 *
 * **Inline and persistent, not a toast.** SPEC.md §11.4 reserves toasts for
 * transient results and asks for inline persistent UI for anything requiring
 * action. A rejected row is the definition of requiring action: someone has to
 * open their spreadsheet, find that line, and fix it. A message that fades after
 * four seconds would make them upload the file again just to read it.
 *
 * It renders on the page rather than inside the upload drawer so the created
 * rows and the refused ones are visible at the same time. The drawer closes when
 * a run finishes; this stays until Dismiss.
 *
 * A clean run is not a warning, so it does not get the amber rule — it gets the
 * quiet one, says what it did, and waits to be dismissed.
 *
 * These rows are **not** `needs_attention_reason` rows — that surface reads from
 * the database and has its own panel. The shape is shared because the meaning is
 * shared, not because the two are the same thing.
 */
export function CsvRejections() {
  const { state, setState } = useCsvUpload()

  // Nothing has run, or the last thing that ran was a whole-file refusal, which
  // the drawer showed beside the file picker.
  if (state.status !== "done") return null

  const { created, rejected } = state.report
  const clean = rejected.length === 0

  const dismiss = (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setState(INITIAL_CSV_UPLOAD_STATE)}
    >
      Dismiss
    </Button>
  )

  if (clean) {
    return (
      <AttentionPanel
        id="csv-report"
        tone="info"
        actions={dismiss}
        heading={`Added ${created} ${plural(created, "appointment")} from the file.`}
      />
    )
  }

  return (
    <AttentionPanel
      id="csv-report"
      actions={dismiss}
      heading={
        <>
          {/* Amber on the number only — the sentence stays ink. */}
          <span className="text-attention">{rejected.length}</span>{" "}
          {plural(rejected.length, "row")} could not be added. Added {created}{" "}
          {plural(created, "appointment")}.
        </>
      }
    >
      {/*
        A native disclosure. No state, no library, and it is already keyboard
        and screen-reader operable — the summary is a button as far as the
        browser is concerned.
      */}
      <details className="text-table">
        <summary className="cursor-pointer text-text-muted underline-offset-4 hover:underline">
          Show the {rejected.length} {plural(rejected.length, "row")}
        </summary>

        <ul className="mt-3 flex flex-col gap-3">
          {rejected.map((row) => (
            <li
              key={row.rowNumber}
              className="flex flex-col gap-1 border-t border-line pt-3 first:border-t-0 first:pt-0"
            >
              <p className="text-table text-text">
                {/* Mono: this is a number to match against a line of a file. */}
                <span className="font-mono text-text-muted">
                  Row {row.rowNumber}
                </span>
                <span aria-hidden className="px-1.5 text-text-muted">
                  ·
                </span>
                {row.name}
              </p>
              {/*
                A list, so a row with two problems reads as two problems rather
                than one long run-on sentence.
              */}
              <ul className="flex flex-col gap-0.5">
                {row.reasons.map((reason) => (
                  <li key={reason} className="text-table text-text-muted">
                    {reason}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </details>
    </AttentionPanel>
  )
}

/** "1 row" but "3 rows". A count with the wrong noun reads as a bug. */
function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`
}
