import { describe, expect, it } from "vitest";

import { formatDuration } from "@/lib/calls/duration";

/*
  Used by the player, the transcript's turn stamps, the header and the Calls
  list. All four render in mono and sit in a column, so a stray `1:5` breaks the
  alignment SPEC.md §11.2 asks for — which is the whole reason this is a shared
  function rather than four call sites doing their own arithmetic.
*/

describe("formatDuration", () => {
  it("pads both halves to two digits", () => {
    expect(formatDuration(65)).toBe("01:05");
  });

  it("renders zero as zero, not as an em-dash", () => {
    expect(formatDuration(0)).toBe("00:00");
  });

  it("carries past an hour without inventing an hours field", () => {
    expect(formatDuration(3661)).toBe("61:01");
  });

  it("gives an em-dash for a duration nobody has reported yet", () => {
    expect(formatDuration(null)).toBe("—");
  });

  it("floors a fractional second rather than showing a decimal", () => {
    expect(formatDuration(65.9)).toBe("01:05");
  });

  it("treats a negative as zero", () => {
    expect(formatDuration(-5)).toBe("00:00");
  });
});
