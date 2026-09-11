import { EmptyState } from "@/components/ui/empty-state"
import { formatDuration } from "@/lib/calls/duration"
import type { TranscriptTurn } from "@/lib/calls/transcript"
import { cn } from "@/lib/utils"

/**
 * The call, set as a script rather than as a chat.
 *
 * Every turn is one row: who spoke in a narrow left column, what they said in a
 * wide right one, a hairline between turns. It used to be chat bubbles — Maya
 * left, the customer right — and that made a record of a phone call look like a
 * messaging app, with the two speakers told apart only by which side of the
 * column they sat on. A script is how a transcript is actually read, and a
 * screen reader gets the same thing the eye does: a name, then the words.
 *
 * The customer's rows carry a faint wash so the two voices separate at a glance
 * without a second colour or a second border.
 *
 * **The speaker label stacks above the text on a phone.** A fixed 96px column is
 * a quarter of a 375px screen, and holding it there would leave a stack of
 * hyphenated names beside a two-word-wide sliver of transcript.
 *
 * A turn with no timestamp renders no timestamp, rather than an em dash. The
 * stamps arrive with the analysed call, minutes after the text does — a call
 * whose transcript has landed and whose stamps have not would otherwise show a
 * column of placeholders, which reads as missing rather than as late.
 */
export function TranscriptPanel({
  turns,
  personName,
}: {
  turns: TranscriptTurn[]
  personName: string
}) {
  if (turns.length === 0) {
    return (
      <EmptyState waiting title="Transcript not ready yet">
        The words arrive once the call has ended. This panel fills in on its own.
      </EmptyState>
    )
  }

  return (
    <ol className="workspace-transcript border-t border-line">
      {turns.map((turn, index) => {
        const isAgent = turn.speaker === "agent"

        return (
          <li
            // Index is a legitimate key here: a transcript is append-only and
            // never reordered, so a turn's position is stable for its lifetime.
            key={index}
            className={cn(
              "flex flex-col gap-1 border-b border-line px-3 py-3 sm:flex-row sm:gap-4",
              !isAgent && "bg-surface-soft",
            )}
          >
            <div className="flex items-baseline gap-2 sm:w-24 sm:shrink-0 sm:flex-col sm:items-start sm:gap-0.5">
              <span
                className={cn(
                  "text-table uppercase tracking-[0.06em]",
                  isAgent ? "text-text" : "text-text-muted",
                )}
              >
                {isAgent ? "Maya" : personName}
              </span>
              {turn.startSeconds !== null ? (
                <span className="font-mono text-table text-text-muted">
                  {formatDuration(turn.startSeconds)}
                </span>
              ) : null}
            </div>

            {/*
              60 characters is the line length prose is comfortable at. Past
              that the eye loses its place coming back to the start of the next
              line, which on a wide screen is exactly what a full-width
              transcript does.
            */}
            <p className="max-w-[60ch] min-w-0 text-[15px] leading-6 text-text">
              {turn.text}
            </p>
          </li>
        )
      })}
    </ol>
  )
}
