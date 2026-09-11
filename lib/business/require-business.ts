import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { cache } from "react";

import type { User } from "@/lib/auth/provision-user";
import { requireUser } from "@/lib/auth/require-user";
import { ONBOARDING_URL } from "@/lib/auth/routes";
import { db, schema } from "@/lib/db";
import type { Business } from "@/lib/onboarding/create-business";

/**
 * The Business behind the current request, and the gate that routes an account
 * without one to Onboarding.
 *
 * The counterpart to `lib/auth/require-user.ts`, one layer up: `requireUser`
 * answers "who is this", this answers "have they set up yet". See ADR-0006 for
 * why the gate lives in the app shell layout rather than in `proxy.ts` — in
 * short, `proxy.ts` is the security boundary and deliberately touches no
 * database, while this is product routing.
 */

/**
 * The signed-in User and their Business, with `business: null` when the account
 * has not onboarded.
 *
 * Wrapped in React `cache()` so the shell layout, the page beneath it and the
 * Quota meter share a single indexed lookup per request instead of one each.
 * That is also what lets the layout keep this as a blocking `await` without the
 * cost ADR-0005 was worried about.
 */
export const currentBusiness = cache(
  async (): Promise<{ user: User; business: Business | null }> => {
    const user = await requireUser();

    // A single-table query, so no `relations()` are needed. `businesses.user_id`
    // is UNIQUE, so `findFirst` is exact rather than arbitrary.
    const business = await db.query.businesses.findFirst({
      where: eq(schema.businesses.userId, user.id),
    });

    return { user, business: business ?? null };
  },
);

/**
 * The same, but sends an account without a Business to Onboarding.
 *
 * Called from `app/(app)/layout.tsx`, which wraps every signed-in screen, so
 * "routed to onboarding from anywhere in the app" holds for routes added later
 * by construction rather than by remembering — the same argument `proxy.ts`
 * makes for listing public routes rather than private ones.
 *
 * There is deliberately no "unless we are already on /onboarding" branch here.
 * `/onboarding` lives outside the `(app)` route group, so it never renders
 * through the layout that calls this and cannot reach it. Loop avoidance is
 * structural; a path check would be the thing that silently breaks later.
 */
export async function requireBusiness(): Promise<{
  user: User;
  business: Business;
}> {
  const { user, business } = await currentBusiness();
  if (!business) redirect(ONBOARDING_URL);
  return { user, business };
}
