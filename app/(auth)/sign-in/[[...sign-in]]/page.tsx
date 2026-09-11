import { SignIn } from "@clerk/nextjs";
import type { Metadata } from "next";

import { AuthCardSkeleton } from "@/components/auth/auth-card-skeleton";

export const metadata: Metadata = {
  title: "Sign in · Callzie",
};

/*
  A catch-all segment, because Clerk routes its own multi-step flows (factor
  two, password reset, SSO callback) as sub-paths of this one. Themed globally
  by `clerkTheme` on the ClerkProvider in app/layout.tsx — nothing to pass here.

  The fallback covers the gap after the page renders but before Clerk's
  browser bundle has downloaded — otherwise the form half sits empty for
  however long that fetch takes.
*/
export default function SignInPage() {
  return <SignIn fallback={<AuthCardSkeleton />} />;
}
