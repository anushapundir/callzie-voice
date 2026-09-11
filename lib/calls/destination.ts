import { parseE164 } from "@/lib/appointments/phone";

/*
  Whether a stored number may be dialled by a Phone Call (issue #19).

  This runs on the Phone Call path only, above the Quota claim, so a refusal
  costs the account nothing. Two separate reasons, because they have different
  answers: a malformed number is a data problem, and a fictional one means you
  are about to demo against the seed.
*/

/**
 * The reserved fictional block: `555-01xx` in any NANP area code, not only
 * 202. NANP is the North American Numbering Plan — the +1 system shared by
 * the US, Canada and a few neighbours — and it reserves this whole block
 * across every area code for fiction. It is never assigned to a real
 * subscriber anywhere in it.
 *
 * `lib/onboarding/templates.ts` picks its numbers from the 202 slice of this
 * block precisely so a real dialler pointed at the seed reaches nobody. That
 * protects the stranger; it does not protect the budget. A Phone Call to one
 * of these still bills — roughly $0.50 of an ~$8 line (docs/verification.md
 * A2) — and then fails in what was meant to be a demo rehearsal. So it is
 * refused here, with a message that says what to do instead.
 *
 * Covering every area code, not just 202, also catches a number someone
 * hand-types while walking through the demo runbook and happens to pick a
 * different area code for — a plausible way to lose money by accident.
 */
const RESERVED_FICTIONAL = /^\+1\d{3}55501\d{2}$/;

type DestinationCheck =
  | { ok: true; number: string }
  | { ok: false; message: string };

/**
 * Whether this number may be dialled, and — when it may be — the exact string
 * to dial.
 *
 * Reuses `parseE164` rather than re-checking the format, so there is one
 * definition of a well-formed number in the codebase. Every write path already
 * runs it — quick-add, CSV upload — which makes the format branch here belt and
 * braces rather than the point. The point is the range below it.
 *
 * The call also normalises: `+1 (202) 555-0110` becomes `+12025550110` before
 * the regex ever sees it, which is the only reason the regex can match at all.
 * Testing `phoneE164` (the raw argument) instead of `parsed.value` would look
 * identical for every test in this file, and would silently reopen the hole
 * for any seeded or hand-typed number written with spaces or brackets.
 *
 * **The caller must dial `number`, not the column it passed in.** That is what
 * `ok: true` carries a payload for. Checking the normalised form and then
 * dialling the raw one would put the whole check back where it started: a
 * fictional number written `+1 (202) 555-0110` would pass, because the string
 * that was tested and the string that gets dialled were never the same string.
 *
 * The format message is this file's own, not `parseE164`'s. `parseE164`'s
 * errors are written for someone typing into a field — "Enter a phone number."
 * makes sense under an input box. This runs when somebody pressed "Call now"
 * and there is no field on screen, so it says where the fix actually is.
 */
export function checkDestination(phoneE164: string): DestinationCheck {
  const parsed = parseE164(phoneE164);
  if (!parsed.ok) {
    return {
      ok: false,
      message:
        "This appointment's phone number isn't usable. Fix it on the " +
        "appointment first.",
    };
  }

  if (RESERVED_FICTIONAL.test(parsed.value)) {
    return {
      ok: false,
      message:
        "That's a demo number. Add an appointment with a real number first.",
    };
  }

  return { ok: true, number: parsed.value };
}
