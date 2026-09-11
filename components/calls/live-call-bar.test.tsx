import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LiveCallBar } from "@/components/calls/live-call-bar";
import { LiveCallContext } from "@/components/calls/live-call-provider";
import { isDismissable, type CallState } from "@/lib/calls/machine";

/**
 * What the bar actually puts on the page, for every state the machine can be in.
 *
 * `lib/calls/machine.test.ts` pins the transitions; this pins the markup they
 * turn into. Worth having separately because the bar is the whole output of a
 * Phone Call — there is no audio and no second state — so a missing line here is
 * a feature that silently does nothing, not a cosmetic slip.
 *
 * `renderToStaticMarkup` rather than a testing library, matching
 * `components/schedule/day-grid.test.tsx`. Nothing below is interacted with: the
 * bar reads context and renders, so a string of HTML is the whole output. The
 * provider itself is not tested here — it needs a real DOM, a microphone and a
 * Retell stub, none of which this project has.
 */

const TARGET = { appointmentId: "appt-1", name: "Priya Sharma" };

/** Renders the bar as if the provider held `state`. */
function bar(state: CallState): string {
  return renderToStaticMarkup(
    <LiveCallContext.Provider
      value={{
        state,
        busy: false,
        agentSpeaking: false,
        audioBlocked: false,
        start: () => {},
        enableAudio: () => {},
        hangUp: () => {},
        dismiss: () => {},
      }}
    >
      <LiveCallBar />
    </LiveCallContext.Provider>,
  );
}

/**
 * Every state, one example each.
 *
 * Listed as a `Record` keyed by `CallState["name"]`, so adding a state to the
 * machine without adding it here is a compile error. That is the same trick the
 * bar's own `never` default uses, for the same reason: this file is only worth
 * anything if it cannot fall behind the machine.
 */
const EXAMPLES: Record<CallState["name"], CallState> = {
  idle: { name: "idle" },
  requesting_mic: { name: "requesting_mic", target: TARGET },
  mic_denied: { name: "mic_denied", target: TARGET },
  placing: { name: "placing", target: TARGET },
  refused: { name: "refused", target: TARGET, message: "You've used all your calls." },
  connecting: {
    name: "connecting",
    target: TARGET,
    callId: "call-1",
    deadlineAt: 0,
  },
  live: { name: "live", target: TARGET, callId: "call-1", startedAt: 0 },
  ended: { name: "ended", target: TARGET, callId: "call-1" },
  expired: { name: "expired", target: TARGET, callId: "call-1" },
  failed: {
    name: "failed",
    target: TARGET,
    callId: "call-1",
    message: "The call failed.",
  },
  dialling: {
    name: "dialling",
    target: TARGET,
    callId: "call-1",
    toNumber: "+442071838750",
  },
};

const DIALLING = EXAMPLES.dialling;

describe("LiveCallBar", () => {
  it("renders nothing at all when there is no Call", () => {
    expect(bar(EXAMPLES.idle)).toBe("");
  });

  it("names the person and the number a Phone Call is ringing", () => {
    const html = bar(DIALLING);

    expect(html).toContain("Priya Sharma");
    // The normalised number that was actually dialled, in mono per §11.2.
    expect(html).toContain("+442071838750");
    expect(html).toContain("font-mono");
  });

  it("announces a ringing Phone Call to a screen reader", () => {
    /*
      The bar text is the entire output of a Phone Call — no audio, and no state
      after this one. Without a live region a screen reader says "Placing the
      call…" and then nothing, ever, while a real phone rings.
    */
    expect(bar(DIALLING)).toContain('role="status"');
  });

  it("says that dismissing does not stop the call", () => {
    // "Dismiss" means "clear this finished thing" in every other state, so next
    // to "Ringing…" it would otherwise read as "cancel".
    expect(bar(DIALLING)).toContain("won’t stop the call");
  });

  it("does not offer Hang up on a Phone Call", () => {
    // There is no line in this browser to hang up, so a button claiming to is a
    // promise nothing can keep.
    expect(bar(DIALLING)).not.toContain("Hang up");
  });

  it("does not claim to be connecting to Maya while a Phone Call is placed", () => {
    // `placing` is shared by both routes, and on a Phone Call nobody is joining
    // anything in the browser.
    const html = bar(EXAMPLES.placing);

    expect(html).toContain("Placing the call…");
    expect(html).not.toContain("Connecting to Maya");
  });

  /*
    The assertion that stops a future state shipping with no exit.

    `busy` is `!isSettled(state)`, so an in-flight state with no Dismiss button
    disables every Call button on the page with no way back except a reload.
    Rendering that button is this switch's job, and nothing else checks.
  */
  it("gives every dismissable state a way out", () => {
    for (const state of Object.values(EXAMPLES)) {
      if (state.name === "idle") continue; // Renders nothing by design.
      if (!isDismissable(state)) continue;

      expect(bar(state), state.name).toContain("Dismiss");
    }
  });

  it("only withholds Dismiss from states that something else ends", () => {
    /*
      The other half of the rule above. A state with no Dismiss button is safe
      only because something other than the person moves it on: `requesting_mic`
      waits on the browser prompt, `placing` on the server, `connecting` on the
      30-second deadline, and `live` on Hang up or the far end. Every one of
      them ends without a reload.

      Pinned as a list so a new state cannot join it quietly. If a state ever
      lands here that nothing else ends, it needs a Dismiss button — not an
      extra name in this array.
    */
    const noExit = Object.values(EXAMPLES)
      .filter((state) => !isDismissable(state))
      .map((state) => state.name);

    expect(noExit).toEqual(["requesting_mic", "placing", "connecting", "live"]);

    // And the one that has no timer behind it offers the button itself.
    expect(bar(EXAMPLES.live)).toContain("Hang up");
  });
});
