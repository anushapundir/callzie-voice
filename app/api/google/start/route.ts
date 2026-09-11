import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { requireBusiness } from "@/lib/business/require-business";
import {
  googleCalendarConfigured,
  googleRedirectUri,
} from "@/lib/google/config";
import {
  GOOGLE_STATUS_PARAM,
  type GoogleStatus,
} from "@/lib/google/connection";
import { STATE_TTL_MS, buildConsentUrl, signState } from "@/lib/google/oauth";

/**
 * Step one of the Google Calendar handshake: mint a signed `state` and hand the
 * browser to Google's consent screen.
 *
 * A Route Handler rather than a Server Action because the outcome is a
 * cross-origin navigation to accounts.google.com. An Action would have to return
 * the URL for the client to follow, which puts the consent URL — and the state
 * bound to this Business — into a response body for no benefit. A plain link to
 * this route is the whole client-side implementation.
 *
 * Not listed as public in `proxy.ts`, deliberately: unlike the Retell webhook,
 * this is a person clicking a button in the app, so a session cookie is exactly
 * the right gate. `requireBusiness()` behind it is the second lock, and it is
 * what supplies the Business the consent is bound to.
 */

/** Redirects home to Settings, which is the only screen that can explain this. */
function toSettings(request: NextRequest, status: GoogleStatus): NextResponse {
  const url = new URL("/settings", request.url);
  url.searchParams.set(GOOGLE_STATUS_PARAM, status);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Before anything else: redirects a signed-out visitor to sign-in and an
  // un-onboarded account to onboarding, and yields the Business this consent
  // will be bound to.
  const { business } = await requireBusiness();

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const stateSecret = process.env.INTERNAL_SECRET;

  /*
    ADR-0004's flag, enforced at the entrance. This route is reachable by URL on
    a deployment that never configured Google — someone following an old link, or
    a Settings screen rendered before the environment changed — and the answer
    has to be a designed "not available here" on Settings, not a crash and not a
    redirect to a Google consent screen for a client id that does not exist.

    INTERNAL_SECRET is checked alongside the flag because without it the state
    cannot be signed, and an unsigned state is not a degraded handshake, it is an
    open callback (see `signState`). Refusing to start is the only safe branch.
  */
  if (!googleCalendarConfigured() || !clientId || !stateSecret) {
    return toSettings(request, "unavailable");
  }

  const state = signState(
    {
      businessId: business.id,
      // 128 random bits. Its only job is to make two states for the same
      // Business at the same moment differ, so a captured state can never be
      // confused with a fresh one.
      nonce: randomBytes(16).toString("hex"),
      expiresAt: Date.now() + STATE_TTL_MS,
    },
    stateSecret,
  );

  return NextResponse.redirect(
    buildConsentUrl({
      clientId,
      redirectUri: googleRedirectUri(),
      state,
    }),
  );
}
