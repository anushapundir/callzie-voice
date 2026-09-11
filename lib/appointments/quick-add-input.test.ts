import { describe, expect, it } from "vitest";

import { parseQuickAddInput } from "@/lib/appointments/quick-add-input";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

const VALID = {
  name: "Priya Sharma",
  phone: "+91 98200 12345",
  serviceId: "6f2a1c4e-0000-4000-8000-000000000001",
  startsAt: "2026-08-17T03:30:00.000Z",
};

describe("parseQuickAddInput", () => {
  it("accepts a filled form and normalises the phone number", () => {
    const parsed = parseQuickAddInput(form(VALID));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.name).toBe("Priya Sharma");
    expect(parsed.value.phoneE164).toBe("+919820012345");
    expect(parsed.value.serviceId).toBe(VALID.serviceId);
    expect(parsed.value.startsAt.toISOString()).toBe("2026-08-17T03:30:00.000Z");
  });

  it("reports every empty field at once, not one per round trip", () => {
    const parsed = parseQuickAddInput(form({}));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual({
      name: "Enter the person's name.",
      phone: "Enter a phone number.",
      serviceId: "Choose a service.",
      startsAt: "Choose a time.",
    });
  });

  it("echoes the submission back so a rejected form repopulates", () => {
    const parsed = parseQuickAddInput(form({ ...VALID, phone: "9820012345" }));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.values).toEqual({
      name: "Priya Sharma",
      phone: "9820012345",
      serviceId: VALID.serviceId,
      startsAt: VALID.startsAt,
    });
  });

  it("passes the phone validator's own message through", () => {
    const parsed = parseQuickAddInput(form({ ...VALID, phone: "9820012345" }));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.phone).toBe(
      "Start with the country code, like +44 or +91.",
    );
  });

  it("rejects a time that is not an instant, rather than throwing", () => {
    const parsed = parseQuickAddInput(form({ ...VALID, startsAt: "tomorrow" }));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.startsAt).toBe("Choose a time from the list.");
  });

  it("rejects a name longer than the ceiling", () => {
    const parsed = parseQuickAddInput(form({ ...VALID, name: "a".repeat(81) }));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.name).toBe("Keep the name under 80 characters.");
  });
});
