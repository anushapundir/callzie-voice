import { describe, expect, it } from "vitest";

import { TEMPLATES } from "@/lib/onboarding/templates";

import { checkDestination } from "./destination";

/*
  Whether a number in `appointments.phone_e164` may be dialled.

  Pure and offline. The fictional-range case is the one worth having: seeded
  Appointments all carry one, so it is the first number a flagged account will
  press "Call now" on, and Retell would bill for the failure.
*/

describe("checkDestination", () => {
  it("accepts a real E.164 number, and hands back the number to dial", () => {
    expect(checkDestination("+919876543210")).toEqual({
      ok: true,
      number: "+919876543210",
    });
  });

  it("accepts a real US number outside the fictional range", () => {
    expect(checkDestination("+12025551234")).toEqual({
      ok: true,
      number: "+12025551234",
    });
  });

  it("hands back the normalised number, not the string it was given", () => {
    /*
      This is the whole reason `ok: true` carries a payload. The range check
      runs on the normalised form, so a caller that dialled its own raw column
      instead would be dialling a string nothing ever checked — and
      `+1 (202) 555-0110` would sail past the fictional-range refusal below.
    */
    expect(checkDestination("+91 (98765) 43210")).toEqual({
      ok: true,
      number: "+919876543210",
    });
    expect(checkDestination("+1 (202) 555-1234")).toEqual({
      ok: true,
      number: "+12025551234",
    });
    expect(checkDestination("+1 (202) 555-0110").ok).toBe(false);
  });

  it("refuses a seeded number from the reserved fictional range", () => {
    const result = checkDestination("+12025550110");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("demo number");
  });

  it("refuses every number the seed templates use", () => {
    // The real seed rows, not a hand-built range. A template that gains an
    // appointment outside the block has to fail here, where the dialler is,
    // rather than only in the templates' own test.
    for (const template of Object.values(TEMPLATES)) {
      for (const appointment of template.appointments) {
        expect(
          checkDestination(appointment.phoneE164).ok,
          appointment.phoneE164,
        ).toBe(false);
      }
    }
  });

  it("accepts numbers just outside the block, so the pattern stays anchored", () => {
    // One below, one above, and one that starts with the block's prefix and
    // keeps going. The last is what makes the trailing `$` a real assertion —
    // without it, a longer number would be refused for no reason.
    expect(checkDestination("+12025550099").ok).toBe(true);
    expect(checkDestination("+12025550200").ok).toBe(true);
    expect(checkDestination("+1202555011000").ok).toBe(true);
  });

  it("refuses the fictional block in any area code, not just the seed's", () => {
    expect(checkDestination("+14155550123").ok).toBe(false);
  });

  it("refuses a number that is not E.164, in dashboard wording", () => {
    // `parseE164`'s own errors are written for someone typing into a field.
    // Nobody pressing "Call now" has a field on screen, so this says where the
    // fix is instead.
    const result = checkDestination("2025551234");

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain(
      "Fix it on the appointment",
    );
  });

  it("refuses an empty number", () => {
    expect(checkDestination("").ok).toBe(false);
  });
});
