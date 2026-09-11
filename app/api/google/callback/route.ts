import { NextResponse, type NextRequest } from "next/server";

import { requireBusiness } from "@/lib/business/require-business";
import {
  googleCalendarConfigured,
  googleRedirectUri,
} from "@/lib/google/config";
import {
  GOOGLE_STATUS_PARAM,
  storeGoogleConnection,
  type GoogleStatus,
} from "@/lib/google/connection";
import {
  exchangeCodeForTokens,
  fetchPrimaryCalendarId,
  verifyState,
} from "@/lib/google/oauth";

/**
 * Step two: Google sends the browser back here, and this decides what — if
 * anything — gets stored.
 *
 * **Every exit is a redirect to `/settings` carrying a status.** Not one of them
 * renders HTML, returns JSON or lets an exception reach the framework's error
 * page. That is not politeness: this URL is the last hop of a flow that started
 * with a person pressing a button, and the failure modes are things they can act
 * on — they cancelled, they left the tab open too long, Google refused. An
 * unstyled 500 tells them none of that and loses the thread back to the screen
 * where the button lives. SPEC.md §11.3 makes the same demand of failed
 * extractions ("a designed amber card [...] never an unstyled error"); this is
 * that rule applied to an endpoint with no UI of its own.
 *
 * `lib/google/connection.ts` holds the status vocabulary and its copy, so
 * Settings renders these without knowing this file exists.
 */

function toSettings(request: NextRequest, status: GoogleStatus): NextResponse {
  const url = new URL("/settings", request.url);
  url.searchParams.set(GOOGLE_STATUS_PARAM, status);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Outside the try below on purpose: `requireBusiness()` signals its redirects
  // by throwing, and catching those would turn "please sign in" into
  // "something went wrong".
  const { business } = await requireBusiness();

  const params = new URL(request.url).searchParams;

  /*
    Google reports a refused consent as a redirect *back here* with `error`
    rather than by not redirecting at all — the browser arrives looking exactly
    like a success. Someone pressing Cancel is the single most likely non-happy
    path this endpoint sees, and it is not a failure; the status distinguishes it
    so Settings can say "not connected" rather than "something broke".
  */
  const error = params.get("error");
  if (error) {
    return toSettings(request, error === "access_denied" ? "denied" : "exchange_failed");
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const stateSecret = process.env.INTERNAL_SECRET;
  if (!googleCalendarConfigured() || !clientId || !clientSecret || !stateSecret) {
    // The environment changed between `start` and here, or someone reached this
    // URL directly on an unconfigured deployment. Either way there is nothing to
    // exchange the code with.
    return toSettings(request, "unavailable");
  }

  const state = params.get("state");
  if (!state) return toSettings(request, "invalid_state");

  const verified = verifyState(state, stateSecret, new Date());
  if (!verified.ok) {
    return toSettings(
      request,
      verified.reason === "expired" ? "expired_state" : "invalid_state",
    );
  }

  /*
    The signature proves *we* minted this state; this proves it was minted for
    the account currently holding the session. Without the second check a valid
    state remains valid in anyone's browser for ten minutes, which is precisely
    the window an attacker needs to bind their own Google account to a victim's
    Business — every future Appointment pushed to a calendar the owner cannot
    see. The state is bound to a Business for exactly this comparison.
  */
  if (verified.businessId !== business.id) {
    return toSettings(request, "invalid_state");
  }

  const code = params.get("code");
  if (!code) return toSettings(request, "exchange_failed");

  try {
    const { accessToken, refreshToken } = await exchangeCodeForTokens({
      code,
      clientId,
      clientSecret,
      redirectUri: googleRedirectUri(),
    });

    /*
      Google issues a refresh token on the first authorisation and, on repeats,
      returns a 200 with the field simply absent (see `buildConsentUrl`). The
      consent URL sets `prompt=consent` to force re-issue, so this should not
      happen — but "should not" is how this exact bug survives in every OAuth
      integration that stores `undefined` and discovers it weeks later.

      When a token is already on file, the connection is intact and this
      re-authorisation is a no-op: return success and touch nothing. Deliberately
      *not* writing the new calendar id either — if the owner authorised a
      different Google account this time, pairing that account's calendar id with
      the previous account's refresh token would produce a connection that fails
      every push while looking correct on Settings. Leaving the row consistent
      and asking them to disconnect first is the honest outcome.

      With nothing on file there is no connection to keep, and the fix is
      genuinely outside Callzie: the grant has to be removed at
      myaccount.google.com/permissions before Google will hand over a new refresh
      token. The status says so.
    */
    if (!refreshToken) {
      return toSettings(
        request,
        business.googleRefreshToken ? "connected" : "no_refresh_token",
      );
    }

    // Degrades to Google's `primary` alias rather than throwing, so a refused or
    // flaky calendar-list read never costs the user the token they just granted.
    const calendarId = await fetchPrimaryCalendarId(accessToken);

    await storeGoogleConnection(business.id, calendarId, refreshToken);

    return toSettings(request, "connected");
  } catch (caught) {
    /*
      One catch for the whole exchange: a refused code, a network failure, a
      Postgres error, a TOKEN_ENCRYPTION_KEY that decodes to the wrong length.
      They differ to us and not to the person waiting, whose next move is "try
      again" in every case.

      Logged as a message, never as the caught value and never with the request:
      the URL carries the authorisation code and the token response carries the
      refresh token, and neither belongs in a log line. `exchangeCodeForTokens`
      already builds its messages from Google's `error` field alone for the same
      reason.
    */
    console.error(
      "Google Calendar connect failed for business",
      business.id,
      caught instanceof Error ? caught.message : "unknown error",
    );
    return toSettings(request, "exchange_failed");
  }
}
