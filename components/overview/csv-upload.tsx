"use client"

import { Loader2, Upload } from "lucide-react"
import * as React from "react"

import { uploadCsvAction } from "@/app/(app)/actions"
import { Button } from "@/components/ui/button"
import { FieldError } from "@/components/ui/field-error"
import { Label } from "@/components/ui/label"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { parseCsvFile } from "@/lib/appointments/csv-file"
import {
  INITIAL_CSV_UPLOAD_STATE,
  type CsvUploadState,
} from "@/lib/appointments/csv-input"
import { cn } from "@/lib/utils"

/**
 * CSV upload (SPEC.md §11.3, issue #8) — the button, the sheet, and the state
 * that outlives both.
 *
 * **The report does not live in the sheet.** Once a file has run, the sheet
 * closes and the list of rejected rows renders on the page, in
 * `components/overview/csv-rejections.tsx`. That is why there is a provider
 * here: the button sits in the Appointments table header and the report sits
 * above the Quick call card, so the two cannot share ordinary component state.
 *
 * A Server Component can be a child of the provider, and a client component
 * nested inside that Server Component still reads the context — React resolves
 * context by position in the rendered tree, not by which module rendered what.
 * So `app/(app)/page.tsx` keeps its Server Components and wraps the lot.
 *
 * **Parsing happens here, in the browser.** SPEC.md §2 fixes PapaParse and puts
 * it client-side. Validation does not: every check below is repeated on the
 * server, because a Server Action is a POST anyone can send. What these checks
 * buy is a round trip, not a guarantee.
 */

/*
  The file input, styled to match `components/ui/input.tsx`.

  `file:` targets the browser's own "Choose file" button inside the control,
  which is otherwise unstyled and renders as a grey OS-native rectangle in the
  middle of a dark card.

  **No `outline-none` here, deliberately.** `components/ui/input.tsx` carries one,
  with a comment saying the component should not draw its own ring because
  `app/globals.css` already gives every `:focus-visible` element the accent
  outline. The intent is right and the utility is the wrong tool for it:
  `outline-none` does not mean "add nothing", it sets `outline-style: none`, and
  because Tailwind utilities outrank the base layer it deletes the global ring
  instead of deferring to it. Copying it here left this control with no visible
  keyboard focus at all, which SPEC.md §11.4 requires on every interactive
  element. Omitting it is what actually defers.
*/
const FILE_INPUT_CLASS = cn(
  "w-full min-w-0 rounded-control border border-line bg-transparent px-2.5 py-1.5 text-body text-text transition-colors",
  "file:mr-3 file:rounded-control file:border-0 file:bg-line file:px-2.5 file:py-1 file:text-table file:text-text",
  "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
  "aria-invalid:border-destructive",
)

type CsvUploadContextValue = {
  state: CsvUploadState
  setState: (state: CsvUploadState) => void
}

const CsvUploadContext = React.createContext<CsvUploadContextValue | null>(null)

export function CsvUploadProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<CsvUploadState>(
    INITIAL_CSV_UPLOAD_STATE,
  )

  const value = React.useMemo(() => ({ state, setState }), [state])

  return (
    <CsvUploadContext.Provider value={value}>
      {children}
    </CsvUploadContext.Provider>
  )
}

/**
 * The report and its setter. Throws outside the provider, so a missing wrapper
 * fails loudly during development rather than silently rendering nothing.
 */
export function useCsvUpload(): CsvUploadContextValue {
  const value = React.useContext(CsvUploadContext)
  if (!value) {
    throw new Error("useCsvUpload must be used inside <CsvUploadProvider>")
  }
  return value
}

export function UploadCsvButton({ timezone }: { timezone: string }) {
  const { setState } = useCsvUpload()

  const [open, setOpen] = React.useState(false)
  const [file, setFile] = React.useState<File | null>(null)
  const [fileError, setFileError] = React.useState<string | null>(null)
  const [uploading, startUploading] = React.useTransition()

  /*
    `useTransition` and a direct call, matching how `quick-call-card.tsx` calls
    `slotOptionsAction` — not `useActionState`. The file has to be read and
    parsed before there is anything to submit, so there is no form submission for
    an action to be attached to.
  */
  async function submit() {
    if (!file) return
    setFileError(null)

    // Parsing lives in `lib/appointments/csv-file.ts` rather than here, so the
    // numbering rule and the whole-file refusals are covered by tests. The repo
    // has no component tests, and a row number that is quietly off by one is
    // only noticed by someone comparing a report against their spreadsheet.
    const parsed = parseCsvFile(await file.text())
    if (!parsed.ok) {
      setFileError(parsed.message)
      return
    }

    startUploading(async () => {
      const result = await uploadCsvAction(parsed.rows)

      // A whole-file refusal stays here, beside the control that picked the
      // file. There is nothing to list per row, so there is nothing for the
      // panel on the page to render.
      if (result.status === "file_error") {
        setFileError(result.message)
        return
      }

      setState(result)
      setOpen(false)
      setFile(null)
    })
  }

  return (
    <>
      {/*
        Outline, not the accent default. §11.2 reserves the accent for primary
        actions, and the primary action on this screen is the Quick call card —
        two accent buttons would make neither look like the demo path.
      */}
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Upload aria-hidden />
        Upload CSV
      </Button>

      <Sheet
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          // Cleared on close so reopening does not show the last file's
          // complaint about a file that is no longer selected.
          if (!next) setFileError(null)
        }}
      >
        {/*
          Wider than the built-in `sm:max-w-sm`, which a column example and a
          long refusal both overflow. The override has to be written as a
          `data-[side=…]` selector to beat the variant it is replacing — see the
          note in `components/app-shell/mobile-nav.tsx`.
        */}
        <SheetContent
          side="right"
          className="data-[side=right]:sm:max-w-lg"
          aria-describedby="csv-upload-description"
        >
          <SheetHeader>
            <SheetTitle>Upload CSV</SheetTitle>
            <SheetDescription id="csv-upload-description">
              One row per person. Times are read in {timezone}.
            </SheetDescription>
          </SheetHeader>

          <div className="flex flex-col gap-4 px-4">
            <div className="flex flex-col gap-2">
              <p className="text-table text-text-muted">
                The file needs these four columns. Anything else is ignored.
              </p>
              {/*
                Mono, and horizontally scrollable rather than wrapped: a wrapped
                example stops looking like a line of a CSV, which is the one
                thing it has to look like.
              */}
              <pre className="overflow-x-auto rounded-control border border-line bg-surface-soft p-2.5 font-mono text-table text-text-muted">
                {"name,phone,service,time\n"}
                {"Priya Raman,+1 202 555 0110,Cleaning,2026-08-21 09:30"}
              </pre>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="csv-file">File</Label>
              <input
                id="csv-file"
                type="file"
                accept=".csv,text/csv"
                className={FILE_INPUT_CLASS}
                onChange={(event) => {
                  setFile(event.target.files?.[0] ?? null)
                  setFileError(null)
                }}
                aria-invalid={Boolean(fileError) || undefined}
                aria-describedby={fileError ? "csv-file-error" : undefined}
              />
              <FieldError id="csv-file-error" message={fileError ?? undefined} />
            </div>
          </div>

          <SheetFooter>
            <Button onClick={submit} disabled={!file || uploading}>
              {/* On the button itself; §11.4 rules out a full-page blocker. */}
              {uploading && <Loader2 className="animate-spin" aria-hidden />}
              {uploading ? "Uploading…" : "Upload"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  )
}
