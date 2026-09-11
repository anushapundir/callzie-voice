import { describe, expect, it } from "vitest";

import { hasOutstandingData } from "@/lib/calls/outstanding";

/*
  Whether the Call detail screen still has anything to wait for.

  Two reasons this is a function rather than an inline condition. It decides
  whether a timer runs at all, so getting it wrong either leaves a page
  refreshing forever or leaves a demo staring at "not ready yet" — and it is the
  one part of the polling story worth a test, because a `setInterval` around
  `router.refresh()` is not.

  A Call that never connected has nothing outstanding. It will never get a
  transcript or a recording, so waiting for them would be waiting forever.
*/

const SETTLED = {
  status: "completed" as const,
  hasTranscript: true,
  hasRecording: true,
  hasExtraction: true,
};

describe("hasOutstandingData", () => {
  it("waits while the Call is queued, ringing or in progress", () => {
    for (const status of ["queued", "ringing", "in_progress"] as const) {
      expect(hasOutstandingData({ ...SETTLED, status })).toBe(true);
    }
  });

  it("waits for a transcript that has not arrived", () => {
    expect(hasOutstandingData({ ...SETTLED, hasTranscript: false })).toBe(true);
  });

  it("waits for a recording that has not arrived", () => {
    expect(hasOutstandingData({ ...SETTLED, hasRecording: false })).toBe(true);
  });

  it("waits for an extraction that has not run", () => {
    expect(hasOutstandingData({ ...SETTLED, hasExtraction: false })).toBe(true);
  });

  it("stops once everything has landed", () => {
    expect(hasOutstandingData(SETTLED)).toBe(false);
  });

  it("stops on a Call that never connected, whatever is missing", () => {
    for (const status of ["no_answer", "failed"] as const) {
      expect(
        hasOutstandingData({
          status,
          hasTranscript: false,
          hasRecording: false,
          hasExtraction: false,
        }),
      ).toBe(false);
    }
  });
});
