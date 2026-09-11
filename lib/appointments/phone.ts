/**
 * Phone numbers as E.164 (SPEC.md §3 rule 10).
 *
 * E.164 is the international format: a `+`, a country code, then the national
 * number, digits only, 15 digits at most. `+12025550142`.
 *
 * Hand-written rather than `libphonenumber-js`, for two reasons. SPEC.md §2
 * fixes the stack and lists no phone library, and this repo already writes its
 * own validators — `lib/onboarding/input.ts`, `lib/settings/services-input.ts`.
 *
 * **No country is inferred, and none can be.** `businesses` carries an IANA
 * timezone and no country column, so there is nothing to anchor a guess at what
 * `9820012345` means. Requiring the `+` is forced by the data model.
 *
 * **This checks shape, not reachability.** A well-formed number belonging to
 * nobody is accepted. Only placing a Call finds that out, which is #11's
 * problem.
 *
 * `ParsedPhone` carries a single `error` string, not the `errors` record
 * `lib/onboarding/input.ts` and `lib/settings/services-input.ts` use — this
 * parses one scalar, not a multi-field form, so there is never more than one
 * thing to say. The caller maps that string onto whichever form field the
 * phone number belongs to.
 */

export type ParsedPhone =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * Spaces, dots, dashes and brackets — how people write numbers, not data.
 * The dash range covers the Unicode look-alikes (en dash, em dash and
 * friends) that a pasted document leaves behind in place of a plain `-`.
 */
const SEPARATORS = /[\s.()\-‐-―]/g;

/**
 * A trunk prefix is the digit — always `0` — that a country's own phone
 * system asks you to dial before a local number, and that you drop when
 * calling from abroad. It is routinely printed in brackets right where it
 * gets dropped: `+44 (0) 20 7946 0018`. Stripping the brackets and keeping
 * the zero would produce `+4402079460018`, a well-formed number that rings
 * nobody. There is no country column on `businesses` to check a shortened
 * number against, so this asks rather than guesses. Checked on the raw
 * input, before separators are stripped, so the brackets are still there to
 * see.
 *
 * The trailing `\d*` catches the other common printing of the same thing —
 * `+44 (020) 7946 0018`, where the trunk zero is bracketed together with the
 * area code. A bracketed group that opens with `0` is a trunk prefix in every
 * international format; `+1 (202) 555-0142` is unaffected, because an area
 * code that is genuinely part of the number never starts with one.
 */
const TRUNK_ZERO_IN_BRACKETS = /\(\s*0\d*\s*\)/;

/** 15 is E.164's ceiling. 8 is ours — a floor to catch a half-typed number. */
const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

export function parseE164(raw: unknown): ParsedPhone {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, error: "Enter a phone number." };
  }

  if (TRUNK_ZERO_IN_BRACKETS.test(raw)) {
    return {
      ok: false,
      error:
        "Drop the 0 in brackets — an international number has no trunk zero. Write +44 20 7946 0018.",
    };
  }

  const compact = raw.replace(SEPARATORS, "");

  if (!compact.startsWith("+")) {
    return { ok: false, error: "Start with the country code, like +44 or +91." };
  }

  const digits = compact.slice(1);

  if (digits.length === 0) {
    return { ok: false, error: "Add the digits after the +." };
  }

  if (digits.includes("+")) {
    return { ok: false, error: "The + goes at the front only, once." };
  }

  if (!/^\d+$/.test(digits)) {
    return {
      ok: false,
      error: "A phone number can only contain digits 0-9, spaces and ( ) -.",
    };
  }

  // Checked before length, so "+0" gets the message that explains the real
  // problem rather than being judged on how many digits followed it.
  if (digits.startsWith("0")) {
    return { ok: false, error: "A country code never starts with a zero." };
  }

  if (digits.length < MIN_DIGITS) {
    return { ok: false, error: "That is too short for an international number." };
  }

  if (digits.length > MAX_DIGITS) {
    return {
      ok: false,
      error: `That is too long — an international number stops at ${MAX_DIGITS} digits.`,
    };
  }

  return { ok: true, value: `+${digits}` };
}
