"use client"

import { Loader2, MicOff, PhoneOff, TriangleAlert, Volume2, VolumeX } from "lucide-react"
import Link from "next/link"
import * as React from "react"

import { useLiveCall } from "@/components/calls/live-call-provider"
import { Button } from "@/components/ui/button"

/**
 * The Call on screen, under the topbar (SPEC.md §11.3, §11.4).
 *
 * A bar rather than a modal, deliberately. SPEC.md §16 step 5 is "cut to the
 * dashboard before hanging up" — the Appointments table has to stay visible
 * while Maya is still talking, and a dialog would cover the one row the whole
 * demo is about.
 *
 * One rendering of every state, whichever button started the Call. Everything
 * here is inline and persistent rather than a toast, per §11.4: each failure
 * names what happened and offers the action that answers it.
 */
export function LiveCallBar() {
  const { state, agentSpeaking, audioBlocked, enableAudio, hangUp, dismiss } =
    useLiveCall()

  if (state.name === "idle") return null

  return (
    <div className="border-b border-line bg-surface px-4 py-2 lg:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-table">
        {(() => {
          switch (state.name) {
            case "requesting_mic":
              return (
                <Status icon={<Loader2 className="animate-spin" aria-hidden />}>
                  Waiting for microphone permission…
                </Status>
              )

            case "mic_denied":
              return (
                <>
                  <Status icon={<MicOff className="text-attention" aria-hidden />}>
                    Callzie needs your microphone to run the call. Allow it from
                    your browser&rsquo;s address bar, then try again.
                  </Status>
                  {/*
                    The reassurance is the point, not politeness. A declined
                    microphone is the one failure that costs nothing, and the
                    strict refund rule is only fair if the screen says so.
                  */}
                  <span className="text-text-muted">No call was used.</span>
                  <Dismiss onClick={dismiss} />
                </>
              )

            /*
              Split from `connecting`, because `placing` happens on both routes
              and `connecting` only ever happens on a Web Call. "Connecting to
              Maya…" is untrue of a Phone Call — she is about to ring the
              customer, and this browser is not joining anything. "Placing the
              call…" is true either way, which is why it is worth two cases
              rather than carrying a route around in the state.
            */
            case "placing":
              return (
                <Status icon={<Loader2 className="animate-spin" aria-hidden />}>
                  Placing the call…
                </Status>
              )

            case "connecting":
              return (
                <Status icon={<Loader2 className="animate-spin" aria-hidden />}>
                  Connecting to Maya…
                </Status>
              )

            case "refused":
              return (
                <>
                  <Status
                    icon={<TriangleAlert className="text-attention" aria-hidden />}
                  >
                    {state.message}
                  </Status>
                  <Dismiss onClick={dismiss} />
                </>
              )

            case "live":
              return (
                <>
                  <span className="flex items-center gap-2 text-text">
                    {/* The live blue is reserved for exactly this signal. */}
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full bg-live animate-live-pulse"
                    />
                    Live with {state.target.name}
                  </span>
                  <Elapsed since={state.startedAt} />

                  {/*
                    Who is talking. Cosmetic on a good Call, diagnostic on a bad
                    one: "Maya is speaking" with nothing audible tells you the
                    problem is playback, not a dead line.
                  */}
                  {agentSpeaking && (
                    <span className="flex items-center gap-1.5 text-text-muted">
                      <Volume2 aria-hidden />
                      Maya is speaking
                    </span>
                  )}

                  {/*
                    Chrome refused to autoplay her audio. The only reliable way
                    past that policy is a genuine click, so this offers one
                    rather than failing silently — which is what it did before.
                  */}
                  {audioBlocked && (
                    <Button size="sm" variant="outline" onClick={enableAudio}>
                      <VolumeX className="text-attention" aria-hidden />
                      Can&rsquo;t hear Maya? Turn on sound
                    </Button>
                  )}

                  {/*
                    The only control on the right edge, and the only solid red
                    in the app. Hanging up is irreversible — the call cannot be
                    resumed — and docs/design.md gives irreversible actions the
                    destructive variant. Solid rather than the tinted default,
                    because on a bar with three or four other bits of text it
                    has to be the thing the eye lands on.
                  */}
                  <span className="ms-auto">
                    <Button
                      variant="destructive"
                      className="bg-declined text-destructive-foreground hover:bg-declined/90"
                      onClick={hangUp}
                    >
                      <PhoneOff aria-hidden />
                      Hang up
                    </Button>
                  </span>
                </>
              )

            case "dialling":
              return (
                <>
                  {/*
                    `role="status"` matters more here than anywhere else in this
                    file. On a Web Call you hear Maya, so the text is a caption
                    on something already happening. On a Phone Call there is no
                    audio in the browser and no state after this one, so this
                    line is the entire output of the feature — without the live
                    region a screen reader announces "Placing the call…" and
                    then nothing, ever, while a real phone rings.
                  */}
                  <span
                    className="flex items-center gap-2 text-text"
                    role="status"
                  >
                    {/* One of the three places §11.2 allows the accent. */}
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full bg-accent animate-live-pulse"
                    />
                    Ringing {state.target.name} at{" "}
                    <span className="font-mono">{state.toNumber}</span>
                  </span>
                  {/*
                    Both halves said plainly rather than left to be discovered.

                    Nothing in this browser will ever learn that the call ended
                    — #13's webhook is what moves the row, and the page re-reads
                    every five seconds waiting for it. A bar that sat spinning
                    forever would read as a hang.

                    And "Dismiss" means "clear this finished thing" everywhere
                    else in this file, so next to "Ringing…" it reads as
                    "cancel". It does not: it closes the bar and re-arms the
                    Call buttons while the phone keeps ringing. Cheaper to say
                    so than to relabel one button.
                  */}
                  <span className="text-text-muted">
                    Dismissing won&rsquo;t stop the call. The dashboard updates
                    when it ends.
                  </span>
                  <Dismiss onClick={dismiss} />
                </>
              )

            case "ended":
              return (
                <>
                  <Status>
                    Call with {state.target.name} ended.{" "}
                    {/*
                      The one moment somebody wants the proof screen, offered
                      where they already are. Without it the bar announced the
                      end of a call and then made them go and find it.
                    */}
                    <Link
                      className="text-text underline decoration-line-strong decoration-1 underline-offset-4 transition-colors hover:decoration-text"
                      href={`/calls/${state.callId}`}
                    >
                      See what happened
                    </Link>
                  </Status>
                  <Dismiss onClick={dismiss} />
                </>
              )

            case "expired":
              return (
                <>
                  <Status
                    icon={<TriangleAlert className="text-attention" aria-hidden />}
                  >
                    The call didn&rsquo;t connect in time — a call has to be
                    joined within 30 seconds of being opened.
                  </Status>
                  <Dismiss onClick={dismiss} />
                </>
              )

            case "failed":
              return (
                <>
                  <Status
                    icon={<TriangleAlert className="text-declined" aria-hidden />}
                  >
                    {state.message}
                  </Status>
                  <Dismiss onClick={dismiss} />
                </>
              )

            default: {
              /*
                Every CallState needs a case above. This line is what makes
                forgetting one a compile error: assigning a leftover state to
                `never` fails, and the message names the state you missed.

                It is the real guard. Before it existed the switch fell off the
                end, the IIFE returned `undefined`, and a state nobody had
                written a case for rendered an empty grey strip — while `busy`
                quietly disabled every Call button on the page. No compile
                error, no runtime error, nothing to notice.
              */
              const unhandled: never = state
              void unhandled
              /*
                Unreachable in a build that compiled — but if it ever ran, the
                one thing the person needs is the way out, because `busy` has
                already disabled every Call button on the page. Rendering
                nothing here would be the empty grey strip. A `throw` would be
                worse: this bar is inside the app shell, so it would unmount
                the shell and lose a live Call.
              */
              return <Dismiss onClick={dismiss} />
            }
          }
        })()}
      </div>
    </div>
  )
}

/**
 * Clear this finished thing from the bar.
 *
 * Inline, right after the message it belongs to — not pushed to the right edge.
 * The right edge is where Hang up lives, and a Dismiss button sitting in the
 * same place on the next state made the two read as one control that sometimes
 * hangs up and sometimes does not.
 */
function Dismiss({ onClick }: { onClick: () => void }) {
  return (
    <Button size="sm" variant="outline" onClick={onClick}>
      Dismiss
    </Button>
  )
}

function Status({
  icon,
  children,
}: {
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  // A live region, so a state change is announced rather than only seen.
  return (
    <span className="flex items-center gap-2 text-text-muted" role="status">
      {icon}
      {children}
    </span>
  )
}

/** How long the Call has been running. Mono, per §11.2's list of faces. */
function Elapsed({ since }: { since: number }) {
  /*
    `Date.now()` in the initialiser is safe here, with no hydration mismatch to
    worry about: the bar renders nothing until a Call leaves `idle`, and a Call
    can only start in the browser. The server never renders this.
  */
  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(interval)
  }, [])

  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  const label = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`

  return <span className="font-mono text-text-muted">{label}</span>
}
