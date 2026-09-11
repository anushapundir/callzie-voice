import type { OnboardingState } from "@/lib/onboarding/input"

/**
 * What the onboarding Server Action hands back, plus one thing.
 *
 * `OnboardingState` (in `lib/onboarding/input.ts`) covers the three *field*
 * errors validation can produce. `formError` is the other kind: the fields were
 * all fine and the write itself failed — the database was unreachable, the seed
 * could not be committed. It belongs to the form, not to any one input, so it
 * renders once above the button rather than under a field.
 *
 * It lives here and not next to the action because `actions.ts` is a
 * `"use server"` module, and such a module may export nothing but async
 * functions — a type declared there could not be imported by the form.
 */
export type OnboardingFormState = OnboardingState & {
  formError?: string
}
