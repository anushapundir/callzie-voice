import { describe, expect, it } from "vitest";

import {
  IDLE,
  isDismissable,
  isSettled,
  reduceCall,
  type CallEvent,
  type CallState,
} from "@/lib/calls/machine";

const TARGET = { appointmentId: "appt-1", name: "Priya Nair" };
const OTHER = { appointmentId: "appt-2", name: "Arun Menon" };

/** Replays a sequence from idle, so each test reads as the story it tests. */
function run(...events: CallEvent[]): CallState {
  return events.reduce(reduceCall, IDLE);
}

const toLive: CallEvent[] = [
  { type: "START", target: TARGET },
  { type: "MIC_GRANTED" },
  { type: "PLACED", callId: "call-1", deadlineAt: 30_000 },
  { type: "SDK_CALL_STARTED", at: 1_000 },
];

describe("the happy path", () => {
  it("walks idle to requesting_mic to placing to connecting to live to ended", () => {
    expect(run({ type: "START", target: TARGET }).name).toBe("requesting_mic");
    expect(run(...toLive.slice(0, 2)).name).toBe("placing");
    expect(run(...toLive.slice(0, 3)).name).toBe("connecting");
    expect(run(...toLive).name).toBe("live");
    expect(run(...toLive, { type: "SDK_CALL_ENDED" }).name).toBe("ended");
  });

  it("carries the person's name all the way through, for the bar to show", () => {
    const state = run(...toLive);
    expect(state.name === "live" && state.target.name).toBe("Priya Nair");
  });

  it("carries the Call id, so the reporters know which row to write", () => {
    const state = run(...toLive, { type: "SDK_CALL_ENDED" });
    expect(state.name === "ended" && state.callId).toBe("call-1");
  });
});

describe("the designed failure states", () => {
  it("reaches mic_denied without a browser", () => {
    expect(
      run({ type: "START", target: TARGET }, { type: "MIC_DENIED" }).name,
    ).toBe("mic_denied");
  });

  it("reaches expired without waiting 30 seconds", () => {
    expect(run(...toLive.slice(0, 3), { type: "DEADLINE_PASSED" }).name).toBe(
      "expired",
    );
  });

  it("reaches refused when the server declines", () => {
    const state = run(...toLive.slice(0, 2), {
      type: "REFUSED",
      message: "You've used all your calls.",
    });
    expect(state).toEqual({
      name: "refused",
      target: TARGET,
      message: "You've used all your calls.",
    });
  });

  it("reaches failed when the SDK errors", () => {
    const state = run(...toLive, { type: "SDK_ERROR", message: "boom" });
    expect(state).toMatchObject({ name: "failed", message: "boom" });
  });

  it("fails a Call that broke before it ever connected", () => {
    const state = run(...toLive.slice(0, 3), {
      type: "SDK_ERROR",
      message: "Error starting call",
    });
    expect(state).toMatchObject({ name: "failed", callId: "call-1" });
  });
});

describe("the three guards", () => {
  it("ignores the deadline once the Call is live", () => {
    // The 30s timer is still running when the Call connects at second three.
    // Without this guard it fires at second thirty and kills a healthy Call.
    expect(run(...toLive, { type: "DEADLINE_PASSED" }).name).toBe("live");
  });

  it("does not resurrect a failed Call when the SDK also reports it ended", () => {
    // The SDK may emit both, in either order.
    const state = run(
      ...toLive,
      { type: "SDK_ERROR", message: "boom" },
      { type: "SDK_CALL_ENDED" },
    );
    expect(state.name).toBe("failed");
  });

  it("ignores a late call_started after the Call has ended", () => {
    const state = run(
      ...toLive,
      { type: "SDK_CALL_ENDED" },
      { type: "SDK_CALL_STARTED", at: 9_000 },
    );
    expect(state.name).toBe("ended");
  });

  it("ignores a call_started that arrives before a Call was placed", () => {
    const state = run(
      { type: "START", target: TARGET },
      { type: "SDK_CALL_STARTED", at: 1_000 },
    );
    expect(state.name).toBe("requesting_mic");
  });

  it("ignores a refusal once the Call is already connecting", () => {
    const state = run(...toLive.slice(0, 3), {
      type: "REFUSED",
      message: "too late",
    });
    expect(state.name).toBe("connecting");
  });
});

describe("starting another Call", () => {
  it("refuses to start while one is live, so a double click cannot abandon it", () => {
    const state = run(...toLive, { type: "START", target: OTHER });
    expect(state.name).toBe("live");
    expect(state.name === "live" && state.target.appointmentId).toBe("appt-1");
  });

  it("refuses to start while one is merely connecting", () => {
    const state = run(...toLive.slice(0, 3), { type: "START", target: OTHER });
    expect(state.name).toBe("connecting");
  });

  it("allows a new Call once the last one settled", () => {
    const state = run(...toLive, { type: "SDK_CALL_ENDED" }, {
      type: "START",
      target: OTHER,
    });
    expect(state).toEqual({ name: "requesting_mic", target: OTHER });
  });

  it("allows a new Call after a declined microphone", () => {
    // Nothing was spent, so trying again must be possible without a reload.
    const state = run({ type: "START", target: TARGET }, { type: "MIC_DENIED" }, {
      type: "START",
      target: TARGET,
    });
    expect(state.name).toBe("requesting_mic");
  });

  it("returns to idle when a settled state is dismissed", () => {
    expect(
      run(...toLive, { type: "SDK_CALL_ENDED" }, { type: "DISMISS" }),
    ).toEqual(IDLE);
  });

  it("ignores a dismiss while the Call is live", () => {
    expect(run(...toLive, { type: "DISMISS" }).name).toBe("live");
  });
});

describe("the phone route", () => {
  const DIAL: CallEvent = {
    type: "DIALLING",
    callId: "call-1",
    toNumber: "+919876543210",
  };

  /** The two events a Phone Call gets, and the only two it ever gets. */
  const toDialling: CallEvent[] = [{ type: "START_PHONE", target: TARGET }, DIAL];

  it("skips the microphone and goes straight to placing", () => {
    const state = reduceCall(IDLE, { type: "START_PHONE", target: TARGET });

    expect(state.name).toBe("placing");
  });

  it("will not start a phone Call over a Call already in flight", () => {
    const placing = reduceCall(IDLE, { type: "START_PHONE", target: TARGET });

    expect(reduceCall(placing, { type: "START_PHONE", target: TARGET })).toBe(
      placing,
    );
  });

  it("will not start a phone Call over a live web one", () => {
    const live = run(...toLive);

    expect(reduceCall(live, { type: "START_PHONE", target: OTHER })).toBe(live);
  });

  it("reaches dialling once the Call is placed", () => {
    expect(run(...toDialling)).toEqual({
      name: "dialling",
      target: TARGET,
      callId: "call-1",
      toNumber: "+919876543210",
    });
  });

  it("ignores a DIALLING that arrives from anywhere but placing", () => {
    // The mirror of the guard on every other event here. `placing` is the only
    // state that asked for a Phone Call, so it is the only one that may become
    // a ringing one.
    expect(reduceCall(IDLE, DIAL)).toBe(IDLE);

    const connecting = run(...toLive.slice(0, 3));
    expect(reduceCall(connecting, DIAL)).toBe(connecting);

    const live = run(...toLive);
    expect(reduceCall(live, DIAL)).toBe(live);

    const dialling = run(...toDialling);
    expect(reduceCall(dialling, DIAL)).toBe(dialling);
  });

  it("refuses a phone Call the same way as a web one", () => {
    const placing = reduceCall(IDLE, { type: "START_PHONE", target: TARGET });
    const state = reduceCall(placing, {
      type: "REFUSED",
      message: "That's a demo number.",
    });

    expect(state.name).toBe("refused");
  });

  it("ignores the whole browser lifecycle, because none of it can happen", () => {
    // No SDK on this route and no token to expire, so every event the Web Call
    // path raises must leave a ringing phone exactly where it is. This is the
    // one-way door: widen any of these to accept `dialling` and it opens.
    const dialling = run(...toDialling);

    expect(reduceCall(dialling, { type: "SDK_CALL_STARTED", at: 1 })).toBe(
      dialling,
    );
    expect(reduceCall(dialling, { type: "SDK_CALL_ENDED" })).toBe(dialling);
    expect(reduceCall(dialling, { type: "SDK_ERROR", message: "boom" })).toBe(
      dialling,
    );
    expect(reduceCall(dialling, { type: "DEADLINE_PASSED" })).toBe(dialling);
    expect(reduceCall(dialling, { type: "MIC_GRANTED" })).toBe(dialling);
    expect(reduceCall(dialling, { type: "MIC_DENIED" })).toBe(dialling);
    expect(
      reduceCall(dialling, { type: "PLACED", callId: "x", deadlineAt: 1 }),
    ).toBe(dialling);
    expect(reduceCall(dialling, { type: "REFUSED", message: "late" })).toBe(
      dialling,
    );
  });

  it("blocks a second Call while the phone is ringing", () => {
    const dialling = run(...toDialling);

    expect(isSettled(dialling)).toBe(false);
    expect(reduceCall(dialling, { type: "START", target: TARGET })).toBe(
      dialling,
    );
    expect(reduceCall(dialling, { type: "START_PHONE", target: TARGET })).toBe(
      dialling,
    );
  });

  it("can still be dismissed, because nothing else will ever end it", () => {
    const dialling = run(...toDialling);

    expect(isDismissable(dialling)).toBe(true);
    expect(reduceCall(dialling, { type: "DISMISS" })).toEqual(IDLE);
  });
});
