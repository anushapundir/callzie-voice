import { describe, expect, it } from "vitest";

import {
  normalizeTimeZone,
  offsetLabel,
  supportedTimeZones,
} from "@/lib/time/timezones";

describe("supportedTimeZones", () => {
  it("returns the full IANA catalogue", () => {
    // The ICU canary. A runtime built with small-icu carries no timezone
    // catalogue, and the failure is invisible until deploy: onboarding works on
    // a dev machine and the picker is empty in production. If this fails, check
    // the runtime image (see ADR-0007) — not this test.
    expect(
      supportedTimeZones().length,
      "small-icu build: this runtime has no timezone catalogue",
    ).toBeGreaterThan(300);
  });

  it("is sorted, so the combobox needs no sort of its own", () => {
    const zones = supportedTimeZones();
    expect([...zones].sort()).toEqual([...zones]);
  });

  it("lists names this runtime can itself resolve", () => {
    // Deliberately not asserting *which* names — that is the ICU-build
    // difference this module exists to absorb. What must hold is that every
    // listed name survives the validator, so the picker cannot offer an option
    // the Server Action would reject.
    for (const zone of supportedTimeZones()) {
      expect(normalizeTimeZone(zone), zone).not.toBeNull();
    }
  });
});

describe("normalizeTimeZone", () => {
  it("resolves a zone to this runtime's name for it", () => {
    expect(normalizeTimeZone("America/New_York")).toBe("America/New_York");
    expect(normalizeTimeZone("UTC")).toBe("UTC");
  });

  it("accepts both spellings of a renamed zone", () => {
    // The case that motivates the whole module: ICU builds disagree about which
    // of these is canonical, so both must be accepted whichever way round this
    // runtime has them. They must also agree on the answer, so a Business ends
    // up with one timezone however its browser spelled it.
    const kolkata = normalizeTimeZone("Asia/Kolkata");
    const calcutta = normalizeTimeZone("Asia/Calcutta");
    expect(kolkata).not.toBeNull();
    expect(calcutta).toBe(kolkata);
  });

  it("accepts link names no catalogue lists", () => {
    // `US/Eastern` is a valid IANA link and appears in no `supportedValuesOf`
    // output. Membership testing would reject it; resolving does not.
    expect(normalizeTimeZone("US/Eastern")).toBe("America/New_York");
  });

  it("normalises so the stored value is stable", () => {
    const first = normalizeTimeZone("US/Eastern");
    expect(normalizeTimeZone(first)).toBe(first);
  });

  it("trims, because a hand-built request may not", () => {
    expect(normalizeTimeZone("  UTC  ")).toBe("UTC");
  });

  it("rejects non-strings and unresolvable zones", () => {
    for (const bad of ["Mars/Olympus", "", "   ", null, undefined, 123, {}, []]) {
      expect(normalizeTimeZone(bad), String(bad)).toBeNull();
    }
  });
});

describe("offsetLabel", () => {
  const summer = new Date("2026-07-01T00:00:00.000Z");
  const winter = new Date("2026-01-01T00:00:00.000Z");

  it("pads to a fixed width so a column of them aligns", () => {
    expect(offsetLabel("UTC", summer)).toBe("+00:00");
    expect(offsetLabel("America/New_York", summer)).toBe("-04:00");
  });

  it("renders sub-hour offsets, which whole-hour formatting would round away", () => {
    expect(offsetLabel("Asia/Kolkata", summer)).toBe("+05:30");
    expect(offsetLabel("Asia/Kathmandu", summer)).toBe("+05:45");
    expect(offsetLabel("Australia/Eucla", summer)).toBe("+08:45");
  });

  it("reflects DST at the given instant", () => {
    expect(offsetLabel("Europe/London", summer)).toBe("+01:00");
    expect(offsetLabel("Europe/London", winter)).toBe("+00:00");
  });
});
