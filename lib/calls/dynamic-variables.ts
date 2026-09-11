import { PROMPT_VARIABLES } from "@/lib/retell/templates";
import { formatForSpeech } from "@/lib/time/zone";

/*
  The values Retell substitutes into the prompt at call time (SPEC.md §7).

  Two facts from docs/verification.md A5 shape this whole file. Every value must
  be a string — a Date or a number is rejected by the API. And an unset variable
  renders LITERALLY to the caller, so a missing key does not fail loudly: it makes
  Maya say "curly-curly-name" to a customer. That is why validation happens here,
  before anything is spent, rather than being discovered on the Call.
*/

/** Key/value pairs for `retell_llm_dynamic_variables`. Strings only. */
export type DynamicVariables = Record<string, string>;

export function buildDynamicVariables(input: {
  businessName: string;
  name: string;
  serviceName: string;
  startsAt: Date;
  /** The Business's IANA zone. The time means nothing without it. */
  timezone: string;
}): DynamicVariables {
  return {
    business_name: input.businessName,
    name: input.name,
    service: input.serviceName,
    /*
      Formatted here, never passed as a Date. This is the conversion A5 warns
      about: Retell rejects a non-string value outright.

      `formatForSpeech`, NOT `formatInZone`. Maya says this out loud, and the
      dashboard format is abbreviated and 24-hour so it stays fixed-width in a
      mono column — read aloud that became "Thu twenty Aug, fourteen thirty".
      The two formats have opposite goals; see lib/time/zone.ts.
    */
    time: formatForSpeech(input.startsAt, input.timezone),
  };
}

export type VariableCheck = { ok: true } | { ok: false; invalid: string[] };

/**
 * Whether every variable the prompts reference is present and speakable.
 *
 * Three problems, one answer: absent, not a string, or blank. Blank is rejected
 * rather than allowed because Retell replaces an empty string with nothing —
 * Maya would say "your appointment on" and stop, which is a worse failure than
 * an obvious placeholder because nobody watching would know what went wrong.
 *
 * Every problem is named at once. A Call refused twice for two different missing
 * fields is two round trips to fix one broken Appointment.
 */
export function validateDynamicVariables(vars: DynamicVariables): VariableCheck {
  const invalid = PROMPT_VARIABLES.filter((key) => {
    const value = vars[key];
    return typeof value !== "string" || value.trim() === "";
  });

  return invalid.length === 0 ? { ok: true } : { ok: false, invalid };
}

/**
 * Substitutes `{{key}}` the way Retell does.
 *
 * **Not used at call time** — Retell performs the real substitution on its own
 * side, and this function is never on the path of a Call. It exists so the test
 * suite can prove that a rendered prompt contains no surviving placeholder, for
 * every Template, without placing one.
 *
 * It lives here rather than in the test file because it is a model of the
 * contract `PROMPT_VARIABLES` is the other half of. A copy inside a test would
 * drift from the variables it is meant to be checking.
 *
 * An unknown key is deliberately left untouched rather than blanked, because
 * that is what Retell does — and it is what makes the sweep able to fail.
 */
export function renderPromptVariables(
  text: string,
  vars: DynamicVariables,
): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) =>
    typeof vars[key] === "string" ? vars[key] : whole,
  );
}
