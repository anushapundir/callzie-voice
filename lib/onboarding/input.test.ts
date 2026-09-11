import { describe, expect, it } from "vitest";

import {
  MAX_BUSINESS_NAME_LENGTH,
  parseOnboardingInput,
} from "@/lib/onboarding/input";

function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

const valid = {
  businessType: "salon",
  name: "Bandra Blowout",
  timezone: "Asia/Kolkata",
};

describe("parseOnboardingInput", () => {
  it("accepts a valid submission and narrows the Business Type", () => {
    const parsed = parseOnboardingInput(formData(valid));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.businessType).toBe("salon");
    expect(parsed.value.name).toBe("Bandra Blowout");
  });

  it("stores the runtime's own spelling of the timezone", () => {
    // ICU builds disagree on whether Kolkata or Calcutta is canonical, so the
    // stored value is whatever this runtime resolves to — not what was sent.
    const parsed = parseOnboardingInput(formData(valid));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.timezone).toBe(
      new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata" })
        .resolvedOptions().timeZone,
    );
  });

  it("trims the name", () => {
    const parsed = parseOnboardingInput(
      formData({ ...valid, name: "   Bandra Blowout   " }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.name).toBe("Bandra Blowout");
  });

  describe("Business Type", () => {
    it("rejects a value outside BUSINESS_TYPES", () => {
      const parsed = parseOnboardingInput(
        formData({ ...valid, businessType: "restaurant" }),
      );

      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.errors.businessType).toBeDefined();
    });

    it("rejects a missing field", () => {
      const data = formData(valid);
      data.delete("businessType");
      const parsed = parseOnboardingInput(data);

      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.errors.businessType).toBeDefined();
    });
  });

  describe("name", () => {
    it("rejects blank and whitespace-only", () => {
      for (const name of ["", "   "]) {
        const parsed = parseOnboardingInput(formData({ ...valid, name }));
        expect(parsed.ok, JSON.stringify(name)).toBe(false);
        if (parsed.ok) return;
        expect(parsed.errors.name).toBeDefined();
      }
    });

    it("accepts exactly the maximum length and rejects one more", () => {
      const atLimit = "a".repeat(MAX_BUSINESS_NAME_LENGTH);
      expect(parseOnboardingInput(formData({ ...valid, name: atLimit })).ok).toBe(
        true,
      );

      const overLimit = "a".repeat(MAX_BUSINESS_NAME_LENGTH + 1);
      const parsed = parseOnboardingInput(formData({ ...valid, name: overLimit }));
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.errors.name).toBeDefined();
    });

    it("measures length after trimming", () => {
      const padded = `  ${"a".repeat(MAX_BUSINESS_NAME_LENGTH)}  `;
      expect(parseOnboardingInput(formData({ ...valid, name: padded })).ok).toBe(
        true,
      );
    });
  });

  describe("timezone", () => {
    it("rejects a zone the runtime cannot resolve", () => {
      const parsed = parseOnboardingInput(
        formData({ ...valid, timezone: "Mars/Olympus" }),
      );

      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.errors.timezone).toBeDefined();
    });

    it("accepts a link name, because a browser may well send one", () => {
      // Rejecting `US/Eastern` would strand anyone whose browser ICU disagrees
      // with the server's about canonical names.
      const parsed = parseOnboardingInput(
        formData({ ...valid, timezone: "US/Eastern" }),
      );

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.timezone).toBe("America/New_York");
    });
  });

  describe("when several fields are wrong", () => {
    const parsed = parseOnboardingInput(
      formData({ businessType: "restaurant", name: "  ", timezone: "Mars/Olympus" }),
    );

    it("reports all of them at once", () => {
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(Object.keys(parsed.errors).sort()).toEqual([
        "businessType",
        "name",
        "timezone",
      ]);
    });

    it("echoes the submission back so the form repopulates", () => {
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.values).toEqual({
        businessType: "restaurant",
        name: "  ",
        timezone: "Mars/Olympus",
      });
    });
  });

  it("ignores unrelated fields, including Next's own", () => {
    const data = formData({ ...valid, $ACTION_ID_abc: "junk", prompt: "ignored" });
    const parsed = parseOnboardingInput(data);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.value).sort()).toEqual([
      "businessType",
      "name",
      "timezone",
    ]);
  });
});
