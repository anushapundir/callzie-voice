import { SignUp } from "@clerk/nextjs";
import type { Metadata } from "next";

import { AuthCardSkeleton } from "@/components/auth/auth-card-skeleton";

export const metadata: Metadata = {
  title: "Create your account · Callzie",
};

/*
  Open signup: anyone with the link gets an account, no invite and no allowlist
  (SPEC.md §14 rule 9). The safety valve is not the door — it is that a signup
  cannot place Phone Calls until `phone_calls_enabled` is set (§3 rule 9).

  The fallback covers the gap while Clerk's browser bundle downloads, same
  as on sign-in.
*/
export default function SignUpPage() {
  return <SignUp fallback={<AuthCardSkeleton />} />;
}
