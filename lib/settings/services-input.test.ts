import { describe, expect, it } from "vitest";

import {
  MAX_SERVICE_MINUTES,
  MAX_SERVICE_NAME_LENGTH,
  MIN_SERVICE_MINUTES,
  parseServiceInput,
} from "@/lib/settings/services-input";

/*
  Pure — no database. Everything this module decides is decided from the
  FormData alone; whether the *change* is allowed is `lib/settings/services.ts`,
  which needs Postgres.
*/

function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

const valid = { name: "Blow-dry", durationMinutes: "30" };

describe("parseServiceInput", () => {
  it("accepts a valid submission and returns the duration as a number", () => {
    const parsed = parseServiceInput(formData(valid));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({ name: "Blow-dry", durationMinutes: 30 });
  });

  it("trims the name", () => {
    const parsed = parseServiceInput(formData({ ...valid, name: "  Colour  " }));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.name).toBe("Colour");
  });

  describe("name", () => {
    it("rejects blank and whitespace-only", () => {
      for (const name of ["", "   "]) {
        const parsed = parseServiceInput(formData({ ...valid, name }));
        expect(parsed.ok, JSON.stringify(name)).toBe(false);
        if (parsed.ok) return;
        expect(parsed.errors.name).toBeDefined();
      }
    });

    it("rejects a missing field", () => {
      const data = formData(valid);
      data.delete("name");
      const parsed = parseServiceInput(data);

      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.errors.name).toBeDefined();
    });

    it("accepts exactly the maximum length and rejects one more", () => {
      const atLimit = "a".repeat(MAX_SERVICE_NAME_LENGTH);
      expect(parseServiceInput(formData({ ...valid, name: atLimit })).ok).toBe(true);

      const parsed = parseServiceInput(
        formData({ ...valid, name: "a".repeat(MAX_SERVICE_NAME_LENGTH + 1) }),
      );
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.errors.name).toBeDefined();
    });

    it("measures length after trimming", () => {
      const padded = `  ${"a".repeat(MAX_SERVICE_NAME_LENGTH)}  `;
      expect(parseServiceInput(formData({ ...valid, name: padded })).ok).toBe(true);
    });
  });

  describe("duration", () => {
    it("accepts both ends of the permitted range", () => {
      for (const minutes of [MIN_SERVICE_MINUTES, MAX_SERVICE_MINUTES]) {
        const parsed = parseServiceInput(
          formData({ ...valid, durationMinutes: String(minutes) }),
        );
        expect(parsed.ok, String(minutes)).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.value.durationMinutes).toBe(minutes);
      }
    });

    it("rejects either side of the range", () => {
      for (const minutes of [MIN_SERVICE_MINUTES - 1, MAX_SERVICE_MINUTES + 1, 0]) {
        const parsed = parseServiceInput(
          formData({ ...valid, durationMinutes: String(minutes) }),
        );
        expect(parsed.ok, String(minutes)).toBe(false);
        if (parsed.ok) return;
        expect(parsed.errors.durationMinutes).toBeDefined();
      }
    });

    it("rejects a negative duration", () => {
      const parsed = parseServiceInput(
        formData({ ...valid, durationMinutes: "-30" }),
      );

      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.errors.durationMinutes).toBeDefined();
    });

    it("rejects a fraction of a minute", () => {
      // `duration_minutes` is an `integer` column and feeds `appointments.ends_at`.
      const parsed = parseServiceInput(
        formData({ ...valid, durationMinutes: "45.5" }),
      );

      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.errors.durationMinutes).toBeDefined();
    });

    it("rejects a non-number", () => {
      const parsed = parseServiceInput(
        formData({ ...valid, durationMinutes: "abc" }),
      );

      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.errors.durationMinutes).toBeDefined();
    });

    it("rejects blank and missing", () => {
      const blank = parseServiceInput(formData({ ...valid, durationMinutes: "" }));
      expect(blank.ok).toBe(false);

      const data = formData(valid);
      data.delete("durationMinutes");
      const missing = parseServiceInput(data);
      expect(missing.ok).toBe(false);
      if (missing.ok) return;
      expect(missing.errors.durationMinutes).toBeDefined();
    });

    it("says something different about each way of being wrong", () => {
      // A single "That is not a valid duration" for all three would leave
      // someone who typed 45.5 guessing at which part offended.
      const messages = ["", "abc", "45.5", "4"].map((durationMinutes) => {
        const parsed = parseServiceInput(formData({ ...valid, durationMinutes }));
        expect(parsed.ok, durationMinutes).toBe(false);
        return parsed.ok ? undefined : parsed.errors.durationMinutes;
      });

      expect(new Set(messages).size).toBe(messages.length);
    });

    it("does not read hex or exponent notation as a duration", () => {
      // `Number("0x1e")` is 30, which is inside the permitted range. A person
      // typing that into a duration field did not mean 30 minutes.
      for (const durationMinutes of ["0x1e", "3e1", " 30 minutes"]) {
        const parsed = parseServiceInput(formData({ ...valid, durationMinutes }));
        expect(parsed.ok, durationMinutes).toBe(false);
      }
    });

    it("tolerates the surrounding whitespace a paste leaves behind", () => {
      const parsed = parseServiceInput(
        formData({ ...valid, durationMinutes: "  30  " }),
      );

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.durationMinutes).toBe(30);
    });
  });

  describe("when both fields are wrong", () => {
    const parsed = parseServiceInput(
      formData({ id: "svc-1", name: "  ", durationMinutes: "abc" }),
    );

    it("reports both at once", () => {
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(Object.keys(parsed.errors).sort()).toEqual([
        "durationMinutes",
        "name",
      ]);
    });

    it("echoes the submission back so the form repopulates", () => {
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.values).toEqual({
        id: "svc-1",
        name: "  ",
        durationMinutes: "abc",
      });
    });
  });

  it("never reports a form-level error — nothing here knows about the database", () => {
    const parsed = parseServiceInput(formData({ name: "", durationMinutes: "" }));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.form).toBeUndefined();
  });

  it("ignores unrelated fields, including Next's own", () => {
    const data = formData({ ...valid, $ACTION_ID_abc: "junk", price: "40" });
    const parsed = parseServiceInput(data);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.value).sort()).toEqual(["durationMinutes", "name"]);
  });
});
