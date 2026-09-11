import { JsonBlock } from "@/components/calls/detail/json-block"
import { Callout } from "@/components/ui/callout"
import { EmptyState } from "@/components/ui/empty-state"
import type { CallExtraction } from "@/lib/calls/detail"
import type { Sentiment } from "@/lib/db/schema"

/**
 * What was SAID — the write-up of the call, read back off the transcript.
 *
 * Below the outcome card, and deliberately: this is a model's reading of the
 * conversation, and the card above is the record of what actually happened.
 * When the two disagree, the one above wins.
 *
 * Rules, not boxes. Each field is a row with a label in the left column and the
 * words in the right, separated by a hairline — the same shape as the transcript
 * beside it, so the two columns of the screen read as one document.
 *
 * **An empty field is an em dash, every time.** There used to be three different
 * ways of saying nothing here — "No summary.", "No notes.", "Not reported." —
 * which made three fields that were all equally empty look like three different
 * situations. One mark, used consistently, says "nothing here" without anybody
 * having to read a sentence to find that out.
 *
 * A failed write-up is a designed amber card, not an error (SPEC.md §11.3), and
 * the raw output is kept because a failed parse that vanishes is a failed parse
 * nobody can fix. The card states the thing a person reading amber most needs to
 * know: what Maya did on the call is recorded separately, and this failure did
 * not touch it.
 */

const SENTIMENT_LABELS: Record<Sentiment, string> = {
  positive: "Positive",
  neutral: "Neutral",
  negative: "Negative",
}

export function ExtractionCard({
  extraction,
}: {
  extraction: CallExtraction | null
}) {
  if (!extraction) {
    return (
      <EmptyState waiting title="Nothing written up yet">
        The write-up runs a few minutes after the call ends. Nothing on the card
        above is waiting on it.
      </EmptyState>
    )
  }

  if (extraction.status === "failed") {
    return (
      <Callout tone="warning" title="The write-up failed">
        <p className="max-w-prose">
          The model&apos;s answer could not be read as the shape Callzie asked
          for, twice. What Maya did on the call is unaffected — the card above is
          the outcome, and nothing here can change it.
        </p>
        <details className="mt-3">
          <summary className="cursor-pointer text-text">
            What the model said
          </summary>
          <div className="mt-2">
            {extraction.rawLlmOutput ? (
              <pre className="overflow-x-auto rounded-control bg-surface-card p-3 font-mono text-table text-text-muted">
                {extraction.rawLlmOutput}
              </pre>
            ) : (
              <p>
                The call failed before the model answered, so nothing was stored.
              </p>
            )}
          </div>
        </details>
      </Callout>
    )
  }

  return (
    <section>
      <h3 className="border-b border-line-strong pb-2 text-section text-text">
        What was said
      </h3>

      <dl>
        <Field label="Summary">{extraction.summary}</Field>
        <Field label="Notes">{extraction.notes}</Field>
        <Field label="Sentiment">
          {extraction.sentiment ? SENTIMENT_LABELS[extraction.sentiment] : null}
        </Field>
      </dl>

      {/* Collapsed, per SPEC.md §11.3. It is here to be checked, not read. */}
      <details className="mt-4">
        <summary className="cursor-pointer text-table text-text-muted">
          Raw JSON
        </summary>
        <div className="mt-2">
          <JsonBlock value={extraction} />
        </div>
      </details>
    </section>
  )
}

/** One field of the write-up. An em dash when the model gave nothing back. */
function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1 border-b border-line py-3 sm:flex-row sm:gap-4">
      <dt className="text-table uppercase tracking-[0.06em] text-text-muted sm:w-24 sm:shrink-0">
        {label}
      </dt>
      <dd className="max-w-prose min-w-0 text-body text-text">
        {children ?? "—"}
      </dd>
    </div>
  )
}
