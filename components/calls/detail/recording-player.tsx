"use client"

import { Pause, Play } from "lucide-react"
import * as React from "react"

import { EmptyState } from "@/components/ui/empty-state"
import { formatDuration } from "@/lib/calls/duration"

/**
 * The call's recording: a play button, a seek bar and the clock, in this app's
 * own type and colours.
 *
 * **The `<audio>` element is still what plays the sound — it has just lost its
 * `controls` attribute.** That attribute draws the browser's own widget, in the
 * browser's grey, with the browser's rounded pill of a scrubber, and it sat in
 * the middle of a designed page looking like something pasted in from another
 * site. Everything visible here is ours; the element underneath is untouched.
 *
 * **The seek bar is an `<input type="range">` on purpose.** Losing `controls`
 * means losing the keyboard, and that is the one thing that must not regress. A
 * range input hands it all back for free and correctly: arrow keys step through
 * the recording, Home and End jump to the ends, it can be dragged or clicked
 * anywhere along its length, and a screen reader already knows how to announce
 * it. A hand-rolled `<div>` with a click handler would have to reimplement every
 * one of those, and would get some of them wrong.
 *
 * One deliberate difference from the native widget: up and down arrows seek here
 * rather than changing the volume. Volume belongs to the system, and the person
 * listening already has a knob for it.
 *
 * `durationSeconds` is what the webhook recorded, and it is the value shown
 * rather than the file's own metadata. The two can disagree by a second; the
 * recorded one is the call's duration and the one that matches the header. The
 * file's own is the fallback, for a call whose webhook has not landed yet.
 */
export function RecordingPlayer({
  recordingUrl,
  durationSeconds,
}: {
  recordingUrl: string | null
  durationSeconds: number | null
}) {
  const audioRef = React.useRef<HTMLAudioElement>(null)
  const [position, setPosition] = React.useState(0)
  const [playing, setPlaying] = React.useState(false)
  const [fileDuration, setFileDuration] = React.useState<number | null>(null)

  if (!recordingUrl) {
    return (
      <EmptyState waiting title="Recording not ready yet">
        The audio is published a few minutes after the call ends, once it has
        been processed. This panel becomes a player on its own.
      </EmptyState>
    )
  }

  const total = durationSeconds ?? fileDuration ?? 0

  /*
    Moving the bar moves the audio, and the audio's own `timeupdate` moves the
    bar back. Setting `currentTime` here as well as in state is what keeps the
    handle under the finger during a drag rather than snapping back a frame
    later.
  */
  const seekTo = (seconds: number) => {
    setPosition(seconds)
    if (audioRef.current) audioRef.current.currentTime = seconds
  }

  return (
    <div className="workspace-recording flex flex-col gap-3">
      <div className="flex items-center gap-4">
        <audio
          ref={audioRef}
          preload="metadata"
          src={recordingUrl}
          onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
          onLoadedMetadata={(event) =>
            setFileDuration(
              Number.isFinite(event.currentTarget.duration)
                ? event.currentTarget.duration
                : null,
            )
          }
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />

        <button
          type="button"
          /*
            32px, the same height as every button in the app. Ink, because it is
            the one thing on this panel you press — and the only filled circle on
            the screen, which is what makes it findable without a label.
          */
          className="flex size-11 shrink-0 items-center justify-center rounded-full bg-accent text-primary-foreground transition-colors hover:bg-accent-active"
          aria-label={playing ? "Pause the recording" : "Play the recording"}
          onClick={() => {
            const audio = audioRef.current
            if (!audio) return
            if (audio.paused) void audio.play()
            else audio.pause()
          }}
        >
          {playing ? (
            <Pause className="size-4 fill-current" aria-hidden />
          ) : (
            <Play className="size-4 fill-current" aria-hidden />
          )}
        </button>

        <input
          type="range"
          className="h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-line-strong disabled:cursor-default [&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-live [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-live"
          /*
            The played part of the track, painted as a gradient rather than as a
            second element: the fill has to stop exactly under the handle, and a
            gradient stop is the only way to say that in one value. Ink for what
            has played, hairline grey for what has not — and the handle itself is
            the cobalt, which is the recording playhead, one of the five places
            in this product allowed to use that colour.
          */
          style={{
            backgroundImage: (() => {
              const played = total > 0 ? (position / total) * 100 : 0
              return `linear-gradient(to right, var(--color-text) ${played}%, transparent ${played}%)`
            })(),
          }}
          min={0}
          max={total || 1}
          // One second a press. A tenth would mean fifty presses to skip a
          // sentence, which is not keyboard access, it is the appearance of it.
          step={1}
          value={Math.min(position, total)}
          disabled={total === 0}
          aria-label="Seek through the recording"
          // Without this a screen reader reads the raw seconds — "ninety five".
          aria-valuetext={`${formatDuration(position)} of ${formatDuration(total)}`}
          onChange={(event) => seekTo(Number(event.currentTarget.value))}
        />

        <p className="shrink-0 font-mono text-table text-text-muted">
          {formatDuration(position)} / {formatDuration(durationSeconds ?? fileDuration)}
        </p>
      </div>

      {/*
        The way out for anyone this player does not work for — a browser that
        will not play the format, or somebody who wants the file itself. It used
        to live inside the `<audio>` element as fallback content, which only ever
        shows on a browser with no audio support at all; with `controls` gone it
        would never have been seen by anyone.
      */}
      <a
        className="self-start text-table text-text-muted underline decoration-line-strong decoration-1 underline-offset-4 transition-colors hover:decoration-text"
        href={recordingUrl}
      >
        Download the recording
      </a>
    </div>
  )
}
