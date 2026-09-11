import { describe, expect, it } from "vitest";

import {
  formatDayHeading,
  formatDayParam,
  parseDayParam,
  resolveDay,
  scheduleHref,
} from "@/lib/schedule/day-param";

const KOLKATA = "Asia/Kolkata";

describe("parseDayParam", () => {
  it("reads a well-formed date", () => {
    expect(parseDayParam("2026-08-19")).toEqual({
      year: 2026,
      month: 8,
      day: 19,
    });
  });

  it("rejects a date that does not exist", () => {
    // Date.UTC(2026, 1, 30) silently rolls to 2 March, so the only way to catch
    // this is to read the parse back.
    expect(parseDayParam("2026-02-30")).toBeNull();
  });

  it("accepts 29 February in a leap year", () => {
    expect(parseDayParam("2028-02-29")).toEqual({
      year: 2028,
      month: 2,
      day: 29,
    });
  });

  it("rejects 29 February in a year that has none", () => {
    expect(parseDayParam("2026-02-29")).toBeNull();
  });

  it("rejects anything that is not YYYY-MM-DD", () => {
    for (const bad of [
      "banana",
      "2026-8-19",
      "19-08-2026",
      "2026-08-19T10:00:00Z",
      "2026-13-01",
      "",
    ]) {
      expect(parseDayParam(bad), bad).toBeNull();
    }
    expect(parseDayParam(null)).toBeNull();
  });

  it("rejects a two-digit year, which Date.UTC would read as the 1900s", () => {
    expect(parseDayParam("0050-01-01")).toBeNull();
  });
});

describe("formatDayParam", () => {
  it("zero-pads the month and the day", () => {
    expect(formatDayParam({ year: 2026, month: 1, day: 5 })).toBe("2026-01-05");
  });
});

describe("resolveDay", () => {
  it("uses the param when it is valid", () => {
    const now = new Date("2026-08-19T03:30:00.000Z");
    expect(resolveDay("2026-12-25", now, KOLKATA)).toEqual({
      year: 2026,
      month: 12,
      day: 25,
    });
  });

  it("falls back to today in the Business's zone, not the viewer's", () => {
    // 20:00 UTC on the 18th is already the 19th in Kolkata (+05:30).
    const now = new Date("2026-08-18T20:00:00.000Z");
    expect(resolveDay(null, now, KOLKATA)).toEqual({
      year: 2026,
      month: 8,
      day: 19,
    });
  });

  it("falls back to today rather than throwing on a bad param", () => {
    const now = new Date("2026-08-19T03:30:00.000Z");
    expect(resolveDay("banana", now, KOLKATA)).toEqual({
      year: 2026,
      month: 8,
      day: 19,
    });
  });
});

describe("scheduleHref", () => {
  it("builds the link a day nav points at", () => {
    expect(scheduleHref({ year: 2026, month: 8, day: 19 })).toBe(
      "/schedule?date=2026-08-19",
    );
  });
});

describe("formatDayHeading", () => {
  it("writes the day the way the heading reads it", () => {
    // 19 August 2026 is a Wednesday.
    expect(formatDayHeading({ year: 2026, month: 8, day: 19 }, KOLKATA)).toBe(
      "Wed, 19 Aug 2026",
    );
  });

  it("does not slip a day in a zone far from UTC in either direction", () => {
    for (const zone of ["Pacific/Auckland", "Pacific/Honolulu"]) {
      expect(
        formatDayHeading({ year: 2026, month: 8, day: 19 }, zone),
        zone,
      ).toBe("Wed, 19 Aug 2026");
    }
  });
});
