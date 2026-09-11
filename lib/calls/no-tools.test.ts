import { describe, expect, it } from "vitest";

import { noToolsSummary, type NoToolsInput } from "@/lib/calls/no-tools";

/*
  The Outcome card's empty state, which must never render blank — that is an
  acceptance criterion on issue #16, and a blank card on the screen whose whole
  job is showing what happened is the worst possible version of this.

  There are five different reasons a Call has no Tool invocations, and they mean
  five different things. Telling them apart is the entire module.

  One ordering matters and is not arbitrary: `newTime` outranks `confirmed`,
  matching `fallbackChange` in lib/extraction/outcome.ts. Somebody who named a
  new time did not agree to the old one, whatever else came back in the same
  object — and the two files must agree, or the card says "confirmed" about an
  Appointment the extraction moved to Needs Attention.
*/

const BASE: NoToolsInput = {
  callStatus: "completed",
  personName: "Priya",
  extraction: null,
};

const extraction = (over: Partial<NonNullable<NoToolsInput["extraction"]>> = {}) => ({
  status: "ok" as const,
  inVoicemail: false,
  confirmed: null,
  newTime: null,
  ...over,
});

describe("noToolsSummary", () => {
  it("defers to the failure card when the Call never connected", () => {
    const summary = noToolsSummary({ ...BASE, callStatus: "no_answer" });

    expect(summary.headline).toBe("Nothing to do — the call did not connect");
    expect(summary.detail).toContain("reason");
  });

  it("says the analysis has not landed yet when there is no extraction row", () => {
    const summary = noToolsSummary(BASE);

    expect(summary.headline).toBe("Maya did nothing on this call");
    expect(summary.detail).toContain("still being written up");
  });

  it("points at the amber card when the extraction failed", () => {
    const summary = noToolsSummary({
      ...BASE,
      extraction: extraction({ status: "failed" }),
    });

    expect(summary.headline).toBe("Maya did nothing on this call");
    expect(summary.detail).toContain("the write-up failed");
  });

  it("says a machine picked up when Retell reported voicemail", () => {
    const summary = noToolsSummary({
      ...BASE,
      extraction: extraction({ inVoicemail: true }),
    });

    expect(summary.headline).toBe("A machine picked up");
    expect(summary.detail).toContain("voicemail");
  });

  it("reports a new time above everything else, and says it was not booked", () => {
    const summary = noToolsSummary({
      ...BASE,
      extraction: extraction({ confirmed: true, newTime: "Friday afternoon" }),
    });

    expect(summary.headline).toBe("Priya asked for a different time");
    expect(summary.detail).toContain("Friday afternoon");
    expect(summary.detail).toContain("not booked");
  });

  it("reports a confirmation from the fallback fields", () => {
    const summary = noToolsSummary({
      ...BASE,
      extraction: extraction({ confirmed: true }),
    });

    expect(summary.headline).toBe("Priya confirmed, but Maya did not record it");
  });

  it("reports a decline from the fallback fields", () => {
    const summary = noToolsSummary({
      ...BASE,
      extraction: extraction({ confirmed: false }),
    });

    expect(summary.headline).toBe("Priya declined, but Maya did not record it");
  });

  it("admits nothing was decided when the fallback fields are empty too", () => {
    const summary = noToolsSummary({ ...BASE, extraction: extraction() });

    expect(summary.headline).toBe("Nothing was decided");
    expect(summary.detail).toContain("Priya");
  });

  it("never returns an empty string for either field", () => {
    const statuses = ["completed", "no_answer", "failed", "in_progress"] as const;

    for (const callStatus of statuses) {
      const summary = noToolsSummary({ ...BASE, callStatus });
      expect(summary.headline.length).toBeGreaterThan(0);
      expect(summary.detail.length).toBeGreaterThan(0);
    }
  });
});
