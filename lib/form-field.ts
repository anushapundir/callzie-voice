/**
 * Reading untrusted fields off a `FormData`.
 *
 * One function, in `lib/` rather than beside any one caller, because every
 * Server Action in the app now parses a form and four modules had grown a
 * byte-identical private copy of it — `lib/onboarding/input.ts`,
 * `lib/settings/hours-input.ts`, `lib/settings/services-input.ts` and
 * `lib/settings/business-type.ts`. The comment below is the whole reason the
 * helper exists, and a comment that has to be re-derived in four places is a
 * comment that will eventually be missing from the fifth.
 */

/**
 * Reads a named field as a string, treating a missing one as empty.
 *
 * The alternative — `Object.fromEntries(formData)` — carries Next's internal
 * `$ACTION_*` keys straight through into application data, so it is never used
 * here. Naming each field explicitly is also what keeps a Server Action's input
 * surface equal to the fields it actually reads: an action is a POST endpoint
 * reachable by anyone who can send it, and a forged extra field should be
 * ignored rather than picked up by a spread.
 *
 * A `File` value reads as empty rather than as `"[object File]"`, so an upload
 * posted into a text field fails validation instead of being coerced into one.
 */
export function field(formData: FormData, name: string): string {
  const raw = formData.get(name);
  return typeof raw === "string" ? raw : "";
}
