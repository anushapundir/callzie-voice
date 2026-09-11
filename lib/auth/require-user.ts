import { auth, currentUser } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";

import { provisionUser, type User } from "@/lib/auth/provision-user";
import { SIGN_IN_URL } from "@/lib/auth/routes";
import { db, schema } from "@/lib/db";

/**
 * The signed-in User for the current request, provisioning the row if this is
 * the account's first authenticated request (ADR-0005).
 *
 * The read comes first and the upsert only runs on a miss, so the steady state
 * is one indexed lookup on `clerk_id` — no write, and no call out to Clerk, on
 * every page render. `currentUser()` is reached for only when a row has to be
 * created, because that is the one moment we need an email we do not have.
 */
export async function requireUser(): Promise<User> {
  const { userId } = await auth();

  // proxy.ts already turns signed-out requests away; this is the second lock,
  // and it is what lets everything downstream treat a User as non-null.
  if (!userId) redirect(SIGN_IN_URL);

  const existing = await db.query.users.findFirst({
    where: eq(schema.users.clerkId, userId),
  });
  if (existing) return existing;

  const clerkUser = await currentUser();
  return provisionUser(
    userId,
    clerkUser?.primaryEmailAddress?.emailAddress ?? null,
  );
}
