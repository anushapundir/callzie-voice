import { describe, expect, it } from "vitest";

import { parseBusinessHoursInput } from "@/lib/settings/hours-input";

/**
 * A weekly grid submission. Any weekday omitted from `days` is left out of the
 * FormData entirely, which is what a browser sends for an unticked checkbox —
 * the distinction the parser turns into "closed".
 */
function formData(
  days: Record<number, { opensAt: string; closesAt: string; open?: boolean }>,
  extra: Record<string, string> = {},
): FormData {
  const data = new FormData();
  for (const [weekday, day] of Object.entries(days)) {
    if (day.open !== false) data.append(`open-${weekday}`, "on");
    data.append(`opensAt-${weekday}`, day.opensAt);
    data.append(`closesAt-${weekday}`, day.closesAt);
  }
  for (const [key, value] of Object.entries(extra)) data.append(key, value);
  return data;
}

const nineToFive = { opensAt: "09:00", closesAt: "17:00" };

describe("parseBusinessHoursInput", () => {
  it("returns only the open days, in weekday order", () => {
    const parsed = parseBusinessHoursInput(
      formData({ 1: nineToFive, 3: { opensAt: "10:30", closesAt: "18:45" } }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual([
      { weekday: 1, opensAt: "09:00", closesAt: "17:00" },
      { weekday: 3, opensAt: "10:30", closesAt: "18:45" },
    ]);
  });

  it("accepts the widest legal window", () => {
    const parsed = parseBusinessHoursInput(
      formData({ 2: { opensAt: "00:00", closesAt: "23:59" } }),
    );

    expect(parsed.ok).toBe(true);
  });

  describe("closed days", () => {
    it("drops a day whose checkbox is absent", () => {
      const parsed = parseBusinessHoursInput(
        formData({ 1: nineToFive, 6: { ...nineToFive, open: false } }),
      );

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.map((d) => d.weekday)).toEqual([1]);
    });

    it("ignores a closed day's times entirely, however broken", () => {
      // The grid leaves the inputs in the DOM behind a disabled row, so whatever
      // they last held is still submitted. Validating it would block a save the
      // person cannot see anything wrong with.
      const parsed = parseBusinessHoursInput(
        formData({
          1: nineToFive,
          0: { opensAt: "not a time", closesAt: "", open: false },
        }),
      );

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.map((d) => d.weekday)).toEqual([1]);
    });
  });

  describe("time format", () => {
    it("rejects anything that is not zero-padded HH:mm", () => {
      for (const opensAt of ["", "9:00", "0900", "09:00:00", "24:00", "09:60", "nope"]) {
        const parsed = parseBusinessHoursInput(
          formData({ 1: { opensAt, closesAt: "17:00" } }),
        );
        expect(parsed.ok, JSON.stringify(opensAt)).toBe(false);
        if (parsed.ok) return;
        expect(parsed.errors.days?.[1]).toBeDefined();
      }
    });

    it("rejects a missing closing time", () => {
      const data = formData({ 1: nineToFive });
      data.delete("closesAt-1");
      const parsed = parseBusinessHoursInput(data);

      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.errors.days?.[1]).toBeDefined();
    });
  });

  describe("window ordering", () => {
    it("rejects an overnight window", () => {
      // Not merely unusual — #6 resolves an opening window as a same-day pair,
      // so 22:00–02:00 would produce no Slots at all rather than an error.
      const parsed = parseBusinessHoursInput(
        formData({ 5: { opensAt: "22:00", closesAt: "02:00" } }),
      );

      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.errors.days?.[5]).toBeDefined();
    });

    it("rejects a zero-length window", () => {
      const parsed = parseBusinessHoursInput(
        formData({ 5: { opensAt: "09:00", closesAt: "09:00" } }),
      );

      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.errors.days?.[5]).toBeDefined();
    });

    it("accepts a one-minute window", () => {
      const parsed = parseBusinessHoursInput(
        formData({ 5: { opensAt: "09:00", closesAt: "09:01" } }),
      );

      expect(parsed.ok).toBe(true);
    });
  });

  describe("no open days", () => {
    it("rejects a grid with every checkbox unticked", () => {
      const parsed = parseBusinessHoursInput(
        formData({ 1: { ...nineToFive, open: false } }),
      );

      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.errors.form).toBeDefined();
      expect(parsed.errors.days).toBeUndefined();
    });

    it("rejects an empty submission", () => {
      const parsed = parseBusinessHoursInput(new FormData());

      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.errors.form).toBeDefined();
    });

    it("does not also complain about the form when one open day is broken", () => {
      // The person has opened a day. Telling them they have opened none would
      // contradict what is on the screen.
      const parsed = parseBusinessHoursInput(
        formData({ 4: { opensAt: "17:00", closesAt: "09:00" } }),
      );

      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.errors.form).toBeUndefined();
      expect(parsed.errors.days?.[4]).toBeDefined();
    });
  });

  describe("when several days are wrong", () => {
    const parsed = parseBusinessHoursInput(
      formData({
        1: nineToFive,
        2: { opensAt: "oops", closesAt: "17:00" },
        4: { opensAt: "18:00", closesAt: "09:00" },
      }),
    );

    it("reports all of them at once", () => {
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(Object.keys(parsed.errors.days ?? {})).toEqual(["2", "4"]);
    });

    it("echoes the whole submission back so the grid repopulates", () => {
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      // Including the good day, and including the days that were never sent —
      // a rejected save must not blank out the rows that were fine.
      expect(parsed.values["open-1"]).toBe("on");
      expect(parsed.values["opensAt-1"]).toBe("09:00");
      expect(parsed.values["opensAt-2"]).toBe("oops");
      expect(parsed.values["closesAt-4"]).toBe("09:00");
      expect(parsed.values["open-0"]).toBeUndefined();
      expect(parsed.values["opensAt-0"]).toBe("");
    });
  });

  it("ignores unrelated fields, including Next's own", () => {
    const parsed = parseBusinessHoursInput(
      formData({ 1: nineToFive }, { $ACTION_ID_abc: "junk", "open-9": "on" }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Weekday 9 does not exist; the loop is driven by WEEKDAYS, not by the keys
    // that happen to be present.
    expect(parsed.value).toHaveLength(1);
  });
});
