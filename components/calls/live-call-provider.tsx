"use client"

import { useRouter } from "next/navigation"
import * as React from "react"

import {
  reportCallEndedAction,
  reportCallFailedAction,
  reportCallStartedAction,
  startCallAction,
  type StartCallState,
} from "@/app/(app)/calls/actions"
import {
  IDLE,
  isSettled,
  reduceCall,
  TOKEN_LIFETIME_MS,
  type CallState,
  type LiveCallTarget,
} from "@/lib/calls/machine"

/**
 * Owns the one Call that can be in flight, for the whole app shell.
 *
 * Three things live here because they must not be duplicated: the microphone
 * request, the `RetellWebClient` instance, and the 30-second deadline. Both
 * surfaces that can start a Call — the Quick Call card and every table row — go
 * through this, so there is one implementation of every state rather than two
 * that drift.
 *
 * It decides nothing. `lib/calls/machine.ts` holds the transitions; this wires
 * events to `dispatch` and performs the side effects.
 */

type LiveCall = {
  state: CallState
  /** True while a Call is in flight, so buttons can disable themselves. */
  busy: boolean
  /** True while Maya is talking, so the bar can say so. */
  agentSpeaking: boolean
  /** True when the browser refused to play her audio — see `enableAudio`. */
  audioBlocked: boolean
  start: (target: LiveCallTarget) => void
  /** Retries playback from inside a real click, which is what Chrome wants. */
  enableAudio: () => void
  hangUp: () => void
  dismiss: () => void
}

/**
 * Exported for one reason: so `live-call-bar.test.tsx` can render the bar in
 * any `CallState` without a browser. Nothing in the app reads it directly —
 * use `useLiveCall`, which fails loudly when there is no provider above it.
 */
export const LiveCallContext = React.createContext<LiveCall | null>(null)

export function useLiveCall(): LiveCall {
  const context = React.useContext(LiveCallContext)
  if (!context) {
    throw new Error("useLiveCall must be used inside <LiveCallProvider>")
  }
  return context
}

/** How often the page re-reads while a Call is live (SPEC.md §11.3). */
const LIVE_REFRESH_MS = 5_000

/**
 * The subset of `RetellWebClient` this file uses.
 *
 * Declared rather than imported so the type does not drag the browser-only
 * package into the module graph — the import below is dynamic for exactly that
 * reason.
 */
type WebClient = {
  startCall: (config: { accessToken: string }) => Promise<void>
  /**
   * Unblocks playback of the Agent's audio — LiveKit's `room.startAudio()`.
   *
   * Not optional. The SDK attaches the Agent's track to an `<audio autoplay>`
   * element, and Chrome's autoplay policy refuses to play it unless the page
   * has user activation. By the time `startCall` runs we are two awaits past
   * the click that started it — the microphone prompt and a server round
   * trip — so that activation has expired and Maya is inaudible with no error
   * anywhere. This is the documented remedy.
   */
  startAudioPlayback: () => Promise<void>
  stopCall: () => void
  on: (event: string, handler: (payload?: unknown) => void) => void
  removeAllListeners: () => void
}

export function LiveCallProvider({
  phoneCallsEnabled,
  children,
}: {
  /**
   * Whether this account places Phone Calls. A UI hint, not a permission.
   *
   * It decides what the browser does around the server call, and only that:
   * whether to ask for the microphone, whether to load the call SDK, whether
   * to arm the 30-second deadline, and which message to show when the server
   * disagrees with the hint.
   *
   * It decides nothing about who gets dialled. The server reads the flag for
   * itself and is the only thing that picks the route, so a lying client
   * cannot reach anybody it should not. Claim "web" on a flagged account and
   * the server places the Phone Call it was always going to place — a real
   * customer is dialled, but only one the flag already permitted. Claim
   * "phone" on an unflagged one and you skipped a prompt you did not need and
   * got a Web Call whose token nothing will use.
   */
  phoneCallsEnabled: boolean
  children: React.ReactNode
}) {
  const [state, dispatch] = React.useReducer(reduceCall, IDLE)
  const router = useRouter()

  const clientRef = React.useRef<WebClient | null>(null)

  /*
    The current state, readable from inside the SDK's callbacks.

    Those callbacks are registered once, at the moment the Call is placed, and
    close over whatever `state` was then. A `call_ended` handler reading `state`
    directly would see the state from three transitions ago.
  */
  const stateRef = React.useRef(state)
  React.useEffect(() => {
    stateRef.current = state
  }, [state])

  /*
    Refresh on every state change, and every 5s while a Call is in flight
    (SPEC.md §11.3).

    Skipped while `idle`, which is the state on every page load — refreshing
    there would refetch the page a second time on every single navigation, for
    a Call that does not exist. Dismissing back to idle changes no data either.

    `dialling` keeps the interval running for the same reason `live` does, and
    needs it more. A Phone Call reports nothing to this browser, so re-reading
    the page is the only way its row can ever change on screen — the bar
    promises the dashboard updates when the call ends, and this is the thing
    that keeps that promise once #13's webhook writes the row.
  */
  React.useEffect(() => {
    if (state.name === "idle") return
    router.refresh()
    if (state.name !== "live" && state.name !== "dialling") return

    const interval = setInterval(() => router.refresh(), LIVE_REFRESH_MS)
    return () => clearInterval(interval)
  }, [state.name, router])

  /*
    The 30-second deadline (docs/verification.md A3).

    Cleared the moment the state leaves `connecting`, and the machine ignores
    `DEADLINE_PASSED` once live — belt and braces, because killing a healthy
    conversation at second thirty would be the worst bug in this file.

    Note the SDK's `stopCall` emits nothing here: it only emits `call_ended` if
    the Call actually connected, and by definition this one never did. So this
    handler reports the failure itself.
  */
  React.useEffect(() => {
    if (state.name !== "connecting") return

    const remaining = Math.max(0, state.deadlineAt - Date.now())
    const callId = state.callId

    const timer = setTimeout(() => {
      clientRef.current?.stopCall()
      dispatch({ type: "DEADLINE_PASSED" })
      // Retell's own reason for this, so #13's webhook agrees rather than
      // contradicts when it writes the same row.
      void reportCallFailedAction(callId, "error_user_not_joined")
    }, remaining)

    return () => clearTimeout(timer)
  }, [state])

  /** Tears the previous Call's client down, so its events cannot leak forward. */
  const releaseClient = React.useCallback(() => {
    clientRef.current?.removeAllListeners()
    clientRef.current = null
  }, [])

  /*
    Whether a Call is being placed right now, set synchronously.

    `stateRef` is not enough on its own. It is written in an effect, so it only
    catches up after React re-renders — and two calls to `start` in the same
    tick would both read the old state, both pass the guard, and both place a
    Call. The machine would refuse the second `START`, but by then the second
    `startCallAction` is already in flight: two Retell Calls, two Quota
    decrements, for one press. This ref closes that window because it is set
    before the first `await`.
  */
  const startingRef = React.useRef(false)

  /*
    Two flags that are orthogonal to the call's lifecycle, so they live beside
    the machine rather than inside it — the same reasoning SPEC.md §5 uses for
    `needs_attention_reason` being orthogonal to `status`. Maya can be speaking
    or not, and her audio can be blocked or not, without either changing what
    state the Call is in.
  */
  const [agentSpeaking, setAgentSpeaking] = React.useState(false)
  const [audioBlocked, setAudioBlocked] = React.useState(false)

  /**
   * Asks the browser to play the Agent's audio.
   *
   * Called automatically once the Call connects, which works whenever Chrome
   * still considers the page activated. When it does not, `audioBlocked` turns
   * on and the bar offers a button that calls this again from inside a real
   * click — the one thing the autoplay policy always accepts.
   */
  const tryAudioPlayback = React.useCallback(async () => {
    const client = clientRef.current
    if (!client) return

    try {
      await client.startAudioPlayback()
      setAudioBlocked(false)
    } catch {
      setAudioBlocked(true)
    }
  }, [])

  const place = React.useCallback(
    async (target: LiveCallTarget) => {
      releaseClient()
      setAgentSpeaking(false)
      setAudioBlocked(false)

      /*
        The server call, wrapped once for both routes.

        A Server Action is a POST, and a POST can throw: the network drops, or a
        deploy answers 500 halfway through. Nothing above catches that. `start`
        wraps this in `try/finally` with no `catch` and calls it as
        `void place(target)`, so a throw here would leave the reducer in
        `placing` — which is neither settled nor dismissable. That is a spinner
        with no Dismiss button, every Call button on the page disabled, and no
        way out but a page reload. `refused` is settled, so this hands the bar
        back.

        The message deliberately does not say "no call was used", which the
        other refusals can say and this one cannot. The throw may have happened
        on the way back rather than on the way out: the server may already have
        claimed the Quota, written the row and reached Retell, and on a flagged
        account a real phone may be ringing right now. We do not know, so the
        message does not pretend to.
      */
      const callServer = async (): Promise<StartCallState | null> => {
        try {
          return await startCallAction(target.appointmentId)
        } catch {
          dispatch({
            type: "REFUSED",
            message:
              "Couldn't reach the server, so we don't know whether that call " +
              "went out. Reload before trying again.",
          })
          return null
        }
      }

      if (phoneCallsEnabled) {
        /*
          No microphone, no SDK, no deadline. The token that expires in 30
          seconds is a Web Call's problem; a Phone Call has nothing to join.
        */
        dispatch({ type: "START_PHONE", target })

        const result = await callServer()
        if (!result) return
        if (!result.ok) {
          dispatch({ type: "REFUSED", message: result.message })
          return
        }
        if (result.callType !== "phone") {
          /*
            The server disagreed with the hint — the flag was turned off in
            another tab between render and press.

            Say what it cost. Nobody was dialled, which is the important half,
            but a Web Call was genuinely placed: the Quota is spent, a `calls`
            row exists and the Appointment is now `calling`, with no browser
            joining it and, until #13's webhook lands, nothing to settle it.
            A message that only said "try again" would buy a second wasted Call
            from someone who did nothing wrong.
          */
          dispatch({
            type: "REFUSED",
            message:
              "Phone calls are off for this account, so that went out as a " +
              "web call. It used a call and nothing joined it. Reload before " +
              "trying again.",
          })
          return
        }

        dispatch({
          type: "DIALLING",
          callId: result.callId,
          toNumber: result.toNumber,
        })
        return
      }

      dispatch({ type: "START", target })

      /*
        The microphone first, before anything is written or spent.

        A decline here costs the account nothing: no Call row, no Retell
        contact, no Quota. That ordering is the whole reason the refund rule can
        stay strict — this is the one failure the browser can prove locally.
      */
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        // We only wanted the answer; the SDK opens its own stream.
        stream.getTracks().forEach((track) => track.stop())
      } catch {
        dispatch({ type: "MIC_DENIED" })
        return
      }
      dispatch({ type: "MIC_GRANTED" })

      const result = await callServer()
      if (!result) return
      if (!result.ok) {
        dispatch({ type: "REFUSED", message: result.message })
        return
      }

      if (result.callType !== "web") {
        // The account was flagged between render and press. It got a Phone
        // Call, which is placed and ringing — say so rather than failing.
        dispatch({
          type: "REFUSED",
          message: "That went out as a phone call. Reload to see it.",
        })
        return
      }

      const { callId, accessToken } = result

      // The deadline starts here, in the browser, rather than on the server, so
      // a clock skew between the two cannot expire a healthy token early.
      dispatch({
        type: "PLACED",
        callId,
        deadlineAt: Date.now() + TOKEN_LIFETIME_MS,
      })

      const fail = (message: string) => {
        dispatch({ type: "SDK_ERROR", message })
        void reportCallFailedAction(callId, "error_retell")
      }

      try {
        // Browser-only, so imported on demand. A static import would pull it
        // into the server bundle and break the build.
        const { RetellWebClient } = await import("retell-client-js-sdk")
        const client = new RetellWebClient() as unknown as WebClient
        clientRef.current = client

        client.on("call_started", () => {
          dispatch({ type: "SDK_CALL_STARTED", at: Date.now() })
          void reportCallStartedAction(callId)
          // The first of two attempts. `call_ready` fires when her track is
          // actually subscribed, which is the one that usually succeeds.
          void tryAudioPlayback()
        })

        // Her audio track has arrived and been attached.
        client.on("call_ready", () => {
          void tryAudioPlayback()
        })

        // So the bar can say "Maya is speaking". Worth having beyond the
        // cosmetics: if she is visibly speaking and nothing is audible, the
        // problem is playback rather than a dead Call, which is exactly the
        // confusion this pair of events resolves.
        client.on("agent_start_talking", () => setAgentSpeaking(true))
        client.on("agent_stop_talking", () => setAgentSpeaking(false))

        client.on("call_ended", () => {
          /*
            Only a Call that was actually live has ended. After an `error` the
            machine is already `failed` and the row is already written, and the
            SDK calls its own `stopCall` on the way out — so without this check
            a broken Call would also be recorded as a clean one.
          */
          const wasLive = stateRef.current.name === "live"
          dispatch({ type: "SDK_CALL_ENDED" })
          if (wasLive) void reportCallEndedAction(callId)
        })

        client.on("error", (payload?: unknown) => {
          // The SDK emits a plain string here, not an Error.
          const message =
            typeof payload === "string"
              ? payload
              : payload instanceof Error
                ? payload.message
                : "The call failed."
          client.stopCall()
          fail(message)
        })

        await client.startCall({ accessToken })
        // Belt and braces: `call_started` may already have fired above, but if
        // the track was subscribed before the listener attached, this is the
        // only attempt that runs.
        void tryAudioPlayback()
      } catch (error) {
        // `startCall` catches its own failures and emits `error` instead of
        // rejecting, so this is the unlikely path — the dynamic import failing,
        // most likely offline. Handled anyway; a silent dead bar is worse.
        fail(error instanceof Error ? error.message : "The call failed.")
      }
    },
    [releaseClient, tryAudioPlayback, phoneCallsEnabled],
  )

  /**
   * `place`, behind the two guards that stop one press becoming two Calls.
   *
   * The machine refuses a `START` while a Call is in flight, so a second press
   * cannot abandon a live one. But the machine only sees the second press after
   * `place` has already asked for the microphone and called the server — so the
   * guards belong here, in front of it, not only inside the reducer.
   */
  const start = React.useCallback(
    async (target: LiveCallTarget) => {
      if (startingRef.current || !isSettled(stateRef.current)) return
      startingRef.current = true

      try {
        await place(target)
      } finally {
        // Released whatever happened. A declined microphone or a refused Call
        // must leave the person able to press the button again.
        startingRef.current = false
      }
    },
    [place],
  )

  const hangUp = React.useCallback(() => {
    /*
      No dispatch here. `stopCall` makes the SDK emit `call_ended`, and letting
      that one path write the row keeps hanging up and the far end hanging up
      identical — one way for a Call to end, not two.
    */
    clientRef.current?.stopCall()
  }, [])

  const dismiss = React.useCallback(() => {
    releaseClient()
    dispatch({ type: "DISMISS" })
  }, [releaseClient])

  const value = React.useMemo<LiveCall>(
    () => ({
      state,
      busy: !isSettled(state),
      // Only meaningful while she is on the line; a stale `true` left over from
      // a finished Call would sit in the bar saying she is still talking.
      agentSpeaking: state.name === "live" && agentSpeaking,
      audioBlocked: state.name === "live" && audioBlocked,
      start: (target: LiveCallTarget) => void start(target),
      enableAudio: () => void tryAudioPlayback(),
      hangUp,
      dismiss,
    }),
    [state, agentSpeaking, audioBlocked, start, tryAudioPlayback, hangUp, dismiss],
  )

  return (
    <LiveCallContext.Provider value={value}>{children}</LiveCallContext.Provider>
  )
}
