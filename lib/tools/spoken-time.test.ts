import { describe, expect, it } from "vitest";

import { spokenTime } from "@/lib/tools/spoken-time";

/*
  Pure. No database, no clock of its own.

  This exists because `formatInZone` in lib/time/zone.ts cannot be reused here.
  That one renders "Thu 20 Aug, 14:00" — fixed-width and 24-hour, correct for a
  dashboard table in a mono face (SPEC.md §11.3), and wrong to read down a phone
  line.
*/

// 14:00 Asia/Kolkata on Thursday 2026-08-20. +05:30, which is the offset a
// formatter doing hour arithmetic gets wrong — and Callzie's first market.
const AFTERNOON = new Date("2026-08-20T08:30:00.000Z");

describe("spokenTime", () => {
  it("names the day, the date and a 12-hour time", () => {
    expect(spokenTime(AFTERNOON, "Asia/Kolkata")).toBe(
      "Thursday 20 August at 2:00 PM",
    );
  });

  it("renders the same instant differently in another zone", () => {
    // Maya reads Business-local time. The instant is not the sentence.
    expect(spokenTime(AFTERNOON, "Europe/London")).toBe(
      "Thursday 20 August at 9:30 AM",
    );
  });

  it("says 12 AM for midnight, not 0 AM", () => {
    expect(spokenTime(new Date("2026-08-19T18:30:00.000Z"), "Asia/Kolkata")).toBe(
      "Thursday 20 August at 12:00 AM",
    );
  });

  it("says 12 PM for noon", () => {
    expect(spokenTime(new Date("2026-08-20T06:30:00.000Z"), "Asia/Kolkata")).toBe(
      "Thursday 20 August at 12:00 PM",
    );
  });

  it("uses the offset in force at the instant, not an average", () => {
    // 2026-11-01 is the US fall-back. 09:00 local on either side of it is a
    // different UTC instant, and both must read back as 9:00 AM.
    expect(spokenTime(new Date("2026-10-31T13:00:00.000Z"), "America/New_York")).toBe(
      "Saturday 31 October at 9:00 AM",
    );
    expect(spokenTime(new Date("2026-11-01T14:00:00.000Z"), "America/New_York")).toBe(
      "Sunday 1 November at 9:00 AM",
    );
  });

  it("handles a quarter-hour zone", () => {
    // Asia/Kathmandu is +05:45. Nothing here does hour arithmetic, so this needs
    // no special case — the test exists to keep it that way.
    expect(spokenTime(AFTERNOON, "Asia/Kathmandu")).toBe(
      "Thursday 20 August at 2:15 PM",
    );
  });
});
