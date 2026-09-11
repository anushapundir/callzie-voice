/*
  The state of the Call currently on screen (SPEC.md §11.3, §11.4).

  Named for the live Call rather than a "session": CONTEXT.md rules that word out
  as a synonym for Call.

  A plain reducer, deliberately. Every state the sticky bar can render is
  reachable by dispatching events at this function, so both of #11's designed
  failure states — a declined microphone and an expired access token — are tested
  without a browser, without Retell, and without spending anything (SPEC.md §3
  rule 11). The component wires SDK events to `dispatch` and renders; it decides
  nothing.

  The transitions that do NOT happen matter as much as the ones that do. The
  Retell SDK is free to emit late, duplicated and out-of-order events, and none
  of them should be able to move a Call that has already finished. So every case
  below names the state it accepts and returns `state` unchanged otherwise,
  rather than throwing — an unexpected event is ordinary, not a bug.
*/

/** Who this Call is for. The bar says the name; the row shimmers on the id. */
export type LiveCallTarget = {
  appointmentId: string;
  name: string;
};

export type CallState =
  | { name: "idle" }
  | { name: "requesting_mic"; target: LiveCallTarget }
  | { name: "mic_denied"; target: LiveCallTarget }
  | { name: "placing"; target: LiveCallTarget }
  | { name: "refused"; target: LiveCallTarget; message: string }
  | {
      name: "connecting";
      target: LiveCallTarget;
      callId: string;
      deadlineAt: number;
    }
  | { name: "live"; target: LiveCallTarget; callId: string; startedAt: number }
  | { name: "ended"; target: LiveCallTarget; callId: string }
  | { name: "expired"; target: LiveCallTarget; callId: string }
  | {
      name: "failed";
      target: LiveCallTarget;
      callId: string | null;
      message: string;
    }
  /**
   * A Phone Call is ringing, and the browser will never learn more than that.
   *
   * No `live`, no `ended`, and that is not an omission. There is no SDK on this
   * route and nobody at the far end reporting to us, so any transition out of
   * here would be the browser claiming to know something only Retell knows.
   * #13's webhook is what settles the row; this state settles the bar.
   */
  | {
      name: "dialling";
      target: LiveCallTarget;
      callId: string;
      toNumber: string;
    };

export type CallEvent =
  | { type: "START"; target: LiveCallTarget }
  | { type: "MIC_GRANTED" }
  | { type: "MIC_DENIED" }
  | { type: "PLACED"; callId: string; deadlineAt: number }
  | { type: "REFUSED"; message: string }
  | { type: "SDK_CALL_STARTED"; at: number }
  | { type: "SDK_CALL_ENDED" }
  | { type: "SDK_ERROR"; message: string }
  | { type: "DEADLINE_PASSED" }
  | { type: "DISMISS" }
  /** Start a Phone Call. No microphone, so no `requesting_mic`. */
  | { type: "START_PHONE"; target: LiveCallTarget }
  | { type: "DIALLING"; callId: string; toNumber: string };

export const IDLE: CallState = { name: "idle" };

/**
 * The access token dies 30 seconds after it is created
 * (docs/verification.md A3).
 *
 * The browser starts this clock when the token arrives, not the server, so a
 * clock skew between the two cannot expire a healthy token early.
 */
export const TOKEN_LIFETIME_MS = 30_000;

/**
 * States with nothing in flight — a new Call may begin, and the bar may be
 * dismissed. Everything else is a Call that is still happening.
 *
 * Typed as state names rather than left as `string[]`, so a typo here is a
 * compile error. Without the type, misspelling `"refused"` would quietly stop
 * that state being settled: Dismiss would do nothing and Call Now would stay
 * disabled forever, with nothing failing to build.
 */
const SETTLED: ReadonlyArray<CallState["name"]> = [
  "idle",
  "mic_denied",
  "refused",
  "ended",
  "expired",
  "failed",
];

/** Whether a new Call may start from here. */
export function isSettled(state: CallState): boolean {
  return SETTLED.includes(state.name);
}

/**
 * Whether the bar may be closed.
 *
 * Wider than `isSettled` by exactly one state. A ringing Phone Call is not
 * settled — no second Call may start while it is in flight, and the buttons stay
 * disabled — but it can never settle on its own either, because nothing in the
 * browser will ever hear it end. Closing it is the person's decision, and this
 * is the only state where those two questions have different answers.
 *
 * Be clear what dismissing a `dialling` Call actually does: it goes to `idle`,
 * which re-arms every Call button, so the next press places a genuinely second
 * Phone Call to the same person while the first one is still ringing. That is
 * the accepted trade. The alternative is a bar with no exit and an account that
 * cannot call anybody until it reloads the page, which is worse — and the bar
 * says "Dismissing won't stop the call" so the choice is an informed one.
 *
 * None of this is a guarantee against double-dialling anyway. Two browser tabs
 * hold two independent copies of this machine and neither can see the other, so
 * nothing in the browser bounds how many Calls an account places. Everything
 * here is courtesy to the person using it, not enforcement.
 *
 * And on this route the bound is not the Quota. `claimCallQuota` lets an admin
 * past the cap — its WHERE is `is_admin OR calls_used < call_quota` — and
 * `setPhoneCallsEnabled` lets only an admin turn the flag on. So every account
 * that can place a Phone Call at all is an account the Quota does not stop.
 *
 * Three other things do. `checkDestination` refuses the reserved fictional
 * numbers, which is every number the seed writes, so a fresh account has
 * nothing it can dial. The Retell credit balance is finite and each Phone Call
 * spends real money out of it (docs/verification.md A2), so the meter that
 * matters is the account's, not ours. And `businesses.is_admin` is never
 * written by application code — getting the flag on at all means somebody typed
 * an UPDATE into a database console. That last one is the real gate; the other
 * two are what keeps an accident cheap.
 */
export function isDismissable(state: CallState): boolean {
  return isSettled(state) || state.name === "dialling";
}

export function reduceCall(state: CallState, event: CallEvent): CallState {
  switch (event.type) {
    case "START":
      // Only from a settled state, so a double click cannot abandon a live Call.
      return isSettled(state)
        ? { name: "requesting_mic", target: event.target }
        : state;

    case "MIC_GRANTED":
      return state.name === "requesting_mic"
        ? { name: "placing", target: state.target }
        : state;

    case "MIC_DENIED":
      return state.name === "requesting_mic"
        ? { name: "mic_denied", target: state.target }
        : state;

    case "PLACED":
      return state.name === "placing"
        ? {
            name: "connecting",
            target: state.target,
            callId: event.callId,
            deadlineAt: event.deadlineAt,
          }
        : state;

    case "REFUSED":
      return state.name === "placing"
        ? { name: "refused", target: state.target, message: event.message }
        : state;

    case "SDK_CALL_STARTED":
      // Only from `connecting`. A late or duplicated event must not re-open a
      // Call that has already ended.
      return state.name === "connecting"
        ? {
            name: "live",
            target: state.target,
            callId: state.callId,
            startedAt: event.at,
          }
        : state;

    case "SDK_CALL_ENDED":
      // Only a live Call can end. After SDK_ERROR the state is `failed` and must
      // stay failed — the SDK emits `error` and then calls its own `stopCall`.
      return state.name === "live"
        ? { name: "ended", target: state.target, callId: state.callId }
        : state;

    case "SDK_ERROR":
      return state.name === "connecting" || state.name === "live"
        ? {
            name: "failed",
            target: state.target,
            callId: state.callId,
            message: event.message,
          }
        : state;

    case "DEADLINE_PASSED":
      // Ignored once live. The 30-second timer is still running when the Call
      // connects at second three; without this it would kill it at thirty.
      return state.name === "connecting"
        ? { name: "expired", target: state.target, callId: state.callId }
        : state;

    case "START_PHONE":
      // Straight to `placing`: a Phone Call needs no microphone, so there is no
      // permission to wait on. Same settled-state guard as START.
      return isSettled(state)
        ? { name: "placing", target: event.target }
        : state;

    case "DIALLING":
      return state.name === "placing"
        ? {
            name: "dialling",
            target: state.target,
            callId: event.callId,
            toNumber: event.toNumber,
          }
        : state;

    case "DISMISS":
      return isDismissable(state) ? IDLE : state;
  }
}
