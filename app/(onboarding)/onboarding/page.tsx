import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { OnboardingForm } from "@/components/onboarding/onboarding-form";
import { currentBusiness } from "@/lib/business/require-business";

export const metadata: Metadata = {
  title: "Set up your business · Callzie",
};

/**
 * The Onboarding screen (SPEC.md §11.3).
 *
 * Carries the exact inverse of the app shell's guard: `(app)` requires a
 * Business, this requires the absence of one. The two live on disjoint route
 * trees, which is what makes a redirect loop structurally impossible rather
 * than something a path check has to remember to prevent — see ADR-0006.
 *
 * `currentBusiness()`, never `requireBusiness()`: the latter redirects here,
 * and calling it from this page would be the loop.
 *
 * Note this page is protected without appearing in `proxy.ts`. That file lists
 * routes to make them *public*, so a screen added later is private by omission.
 * Signed out, `/onboarding` correctly bounces to `/sign-in` and returns.
 */
export default async function OnboardingPage() {
  const { business } = await currentBusiness();
  if (business) redirect("/");

  return <OnboardingForm />;
}
