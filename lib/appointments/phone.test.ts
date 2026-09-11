import { describe, expect, it } from "vitest";

import { parseE164 } from "@/lib/appointments/phone";

describe("parseE164", () => {
  it("strips the separators a person types", () => {
    expect(parseE164("+1 (202) 555-0142")).toEqual({
      ok: true,
      value: "+12025550142",
    });
  });

  it("accepts the seed's reserved fictional range unchanged", () => {
    // lib/onboarding/seed-schedule.ts writes +1 202 555 01xx on purpose.
    expect(parseE164("+12025550101")).toEqual({ ok: true, value: "+12025550101" });
  });

  it("accepts a half-hour-zone number at full length", () => {
    expect(parseE164("+91 98200 12345")).toEqual({
      ok: true,
      value: "+919820012345",
    });
  });

  it("asks for a country code when there is no plus", () => {
    expect(parseE164("9820012345")).toEqual({
      ok: false,
      error: "Start with the country code, like +44 or +91.",
    });
  });

  it("rejects an empty field with its own message", () => {
    expect(parseE164("   ")).toEqual({
      ok: false,
      error: "Enter a phone number.",
    });
  });

  it("rejects letters", () => {
    expect(parseE164("+1 202 555 CALL")).toEqual({
      ok: false,
      error: "A phone number can only contain digits 0-9, spaces and ( ) -.",
    });
  });

  it("rejects a country code starting with zero", () => {
    expect(parseE164("+0202555014")).toEqual({
      ok: false,
      error: "A country code never starts with a zero.",
    });
  });

  it("rejects too few digits", () => {
    expect(parseE164("+1234567")).toEqual({
      ok: false,
      error: "That is too short for an international number.",
    });
  });

  it("rejects more than E.164's fifteen digits", () => {
    expect(parseE164("+1234567890123456")).toEqual({
      ok: false,
      error: "That is too long — an international number stops at 15 digits.",
    });
  });

  it("accepts both ends of the permitted digit count", () => {
    // 8 is our own floor, not E.164's — see the comment on MIN_DIGITS. 15 is
    // E.164's ceiling. Pinning both sides matters: flipping < to <= on either
    // bound would leave the "too short"/"too long" tests above still green.
    expect(parseE164("+12345678")).toEqual({ ok: true, value: "+12345678" });
    expect(parseE164("+123456789012345")).toEqual({
      ok: true,
      value: "+123456789012345",
    });
  });

  it("rejects a trunk zero printed in brackets rather than silently keeping it", () => {
    // +44 (0) 20 7946 0018 is how UK (and German, Dutch, Indian, Australian)
    // numbers are routinely printed. The (0) is a trunk prefix — dial it only
    // from inside the country, drop it when calling from abroad. Stripping the
    // brackets and keeping the zero would produce +4402079460018, a
    // well-formed number that rings nobody. There is no country column to
    // check a shortened number against, so this asks rather than guesses.
    expect(parseE164("+44 (0) 20 7946 0018")).toEqual({
      ok: false,
      error:
        "Drop the 0 in brackets — an international number has no trunk zero. Write +44 20 7946 0018.",
    });
  });

  it("rejects a trunk zero bracketed together with the area code", () => {
    // The other common printing of the same thing. It reduces to the same
    // wrong number, +4402079460018, so it has to be refused the same way.
    expect(parseE164("+44 (020) 7946 0018")).toEqual({
      ok: false,
      error:
        "Drop the 0 in brackets — an international number has no trunk zero. Write +44 20 7946 0018.",
    });
  });

  it("still accepts a bracketed area code that is part of the number", () => {
    // +1 (202) does not open with a zero, so broadening the trunk-zero check
    // must not catch it. This is the test that pins that boundary.
    expect(parseE164("+1 (202) 555-0142")).toEqual({
      ok: true,
      value: "+12025550142",
    });
  });

  it("asks for digits rather than blaming characters when there are none", () => {
    expect(parseE164("+")).toEqual({
      ok: false,
      error: "Add the digits after the +.",
    });
    expect(parseE164("+()-")).toEqual({
      ok: false,
      error: "Add the digits after the +.",
    });
  });

  it("rejects a second + rather than folding it into the digits-only message", () => {
    expect(parseE164("++12025550142")).toEqual({
      ok: false,
      error: "The + goes at the front only, once.",
    });
    expect(parseE164("+12025550142+")).toEqual({
      ok: false,
      error: "The + goes at the front only, once.",
    });
  });

  it("tolerates an en dash, the way a pasted document writes one", () => {
    expect(parseE164("+1–202–555–0142")).toEqual({
      ok: true,
      value: "+12025550142",
    });
  });

  it("rejects undefined instead of throwing, for a CSV row missing the column", () => {
    expect(parseE164(undefined)).toEqual({
      ok: false,
      error: "Enter a phone number.",
    });
  });
});
