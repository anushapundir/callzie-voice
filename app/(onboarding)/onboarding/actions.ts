"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import type { OnboardingFormState } from "@/components/onboarding/state";
import { requireUser } from "@/lib/auth/require-user";
import { createOnboardedBusiness } from "@/lib/onboarding/create-business";
import { parseOnboardingInput } from "@/lib/onboarding/input";

/**
 * Creates the Business and everything its Template seeds, then lands the person
 * on Overview.
 *
 * Shaped for `useActionState`, so the first argument is the previous state
 * (`node_modules/next/dist/docs/01-app/02-guides/forms.md`, "Validation
 * errors"). Only the async action is exported: a `"use server"` module may
 * export nothing else, which is why the state types and the initial value live
 * in `lib/onboarding/input.ts`.
 *
 * **This action closes over nothing, deliberately.** Every input comes from
 * `FormData` or from `auth()`. That is no longer forced on us — since ADR-0008
 * the key Next uses to encrypt closed-over variables is a stable build input,
 * so a bound argument would work — but the property is still worth keeping.
 * Nothing here needs one, and not sending a value to the browser at all beats
 * encrypting it on the way. See
 * `docs/adr/0008-server-actions-key-is-a-build-input.md`.
 */
export async function completeOnboarding(
  _previous: OnboardingFormState,
  formData: FormData,
): Promise<OnboardingFormState> {
  /*
    A Server Action runs as a POST against the page and is reachable by anyone
    who can send that POST — rendering the form on an authenticated screen is
    not a security boundary (Next's Server Actions guide, "Security"). This is
    the check that matters, and it also guarantees a `users` row exists for the
    foreign key below.
  */
  const user = await requireUser();

  const parsed = parseOnboardingInput(formData);
  if (!parsed.ok) {
    return { errors: parsed.errors, values: parsed.values };
  }

  /*
    Outside the transaction and before the redirect. `redirect()` works by
    throwing, so calling it inside `db.transaction` would roll the whole seed
    back and leave the account exactly where it started — bounced to /onboarding
    again with nothing written.

    **Only this call is inside the try.** `redirect()` below also works by
    throwing, so widening this block to cover it would catch every *successful*
    onboarding and show an error on the one path that worked. That is the trap
    this shape exists to avoid.

    Without the catch, a write that fails — the database unreachable, the seed
    rejected — threw all the way out and the person got Next's default error
    page, losing the three answers they had just given. Returning the failure as
    state keeps them on the form with everything still filled in.
  */
  try {
    await createOnboardedBusiness({ userId: user.id, ...parsed.value });
  } catch (error) {
    // Logged in full, reported in plain words. The real message is a database
    // error, which tells the owner of a salon nothing and may name internals.
    console.error("onboarding: failed to create business", error);
    return {
      formError: "Something went wrong on our end. Try again in a moment.",
      values: {
        businessType: parsed.value.businessType,
        name: parsed.value.name,
        timezone: parsed.value.timezone,
      },
    };
  }

  // Before the redirect, because redirect throws and nothing after it runs. The
  // app shell reads the Business for the Quota meter, so its cached render from
  // before onboarding has to go.
  revalidatePath("/", "layout");

  // Outside any try/catch — the thrown control-flow exception is how Next
  // performs the navigation, and catching it would swallow the redirect.
  redirect("/");
}
