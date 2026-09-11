import { eq } from "drizzle-orm";

import { googleCalendarConfigured } from "@/lib/google/config";
import { clearGoogleConnection } from "@/lib/google/connection";
import { decryptSecret } from "@/lib/google/crypto";
import { GOOGLE_TOKEN_ENDPOINT, PRIMARY_CALENDAR_ALIAS } from "@/lib/google/oauth";
import { db, schema } from "@/lib/db";

/**
 * Turns a stored refresh token into an access token Callzie can push with.
 *
 * Every Google call in this codebase starts here, and every one of them happens
 * with nobody watching — ADR-0004's push runs when an Appointment is booked,
 * which is whenever a Call happens rather than whenever somebody is at a
 * screen. So this function's job is not only to produce a token but to decide,
 * unattended, what to do when it cannot.
 *
 * **`null` is the whole error channel.** Not configured, not connected, grant
 * gone, Google unreachable — all of them return `null` and the caller does
 * nothing. Nothing here throws, because ADR-0004's hard requirement is that
 * "Callzie must be fully functional for a Business that never connects Google",
 * and a Business whose calendar broke this morning is in exactly that position.
 *
 * **The seven-day clock.** Google issues a refresh token that expires after
 * **seven days** to any app whose OAuth consent screen is in Testing status and
 * which asks for anything beyond name, email and profile. `calendar.events` is
 * such a scope, and ADR-0004 ships this integration in Testing status
 * deliberately rather than wait weeks for verification. So a dead grant is the
 * ordinary weekly case here, not an exotic failure, and `invalid_grant` is a
 * path this code is expected to take.
 */

/** What a caller needs to talk to one Business's calendar. */
export type CalendarAccess = {
  accessToken: string;
  /** Google's alias, or the owner's real address if the connect flow read it. */
  calendarId: string;
};

export async function accessTokenFor(
  businessId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CalendarAccess | null> {
  // Before anything else, and before any query: a deployment with no Google
  // credentials is correctly configured, not degraded (ADR-0004).
  if (!googleCalendarConfigured()) return null;

  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.id, businessId),
    columns: { googleRefreshToken: true, googleCalendarId: true },
  });

  if (!business?.googleRefreshToken) return null;

  /*
    ADR-0009: everything that reads this column goes through `decryptSecret`. A
    throw here means the stored value cannot be turned back into a credential —
    a wrong TOKEN_ENCRYPTION_KEY, a truncated row, a value from a future
    version. None of those is recoverable by retrying and none of them is
    Google's fault, so the connection is not cleared: clearing would destroy the
    ciphertext that a restored key would still decrypt.
  */
  let refreshToken: string;
  try {
    refreshToken = decryptSecret(business.googleRefreshToken);
  } catch (error) {
    console.error(
      `Could not decrypt the Google refresh token for business ${businessId}`,
      error,
    );
    return null;
  }

  const accessToken = await refresh(businessId, refreshToken, fetchImpl);
  if (!accessToken) return null;

  return {
    accessToken,
    // `primary` is valid as a calendarId on every Calendar API endpoint, so an
    // unread calendar list costs a pretty label and nothing else.
    calendarId: business.googleCalendarId ?? PRIMARY_CALENDAR_ALIAS,
  };
}

async function refresh(
  businessId: string,
  refreshToken: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      // Form-encoded, not JSON — Google's token endpoint rejects a JSON body
      // with `invalid_request`, which reads like a bad parameter rather than a
      // bad content type. Same trap `exchangeCodeForTokens` documents.
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID ?? "",
        client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });
  } catch (error) {
    // Google unreachable. Transient by assumption, so the credential is left
    // exactly as it is.
    console.error(`Could not reach Google to refresh ${businessId}`, error);
    return null;
  }

  const body = (await response.json().catch(() => null)) as {
    access_token?: string;
    error?: string;
  } | null;

  if (!response.ok) {
    /*
      **Only `invalid_grant` destroys anything.** It is Google's documented,
      definitive "this grant is gone", covering both an owner revoking access at
      myaccount.google.com and the seven-day Testing-status expiry above. Both
      mean the same thing to the owner — reconnect — so both are handled
      identically.

      Google also returns an `error_subtype` that separates a revocation from a
      session-control policy. It is not read, because the answer is the same
      either way, but it exists if a future ticket needs to word the two
      differently.

      Anything else — a 500, a 429, a network blip already caught above — leaves
      the stored token untouched. A transient Google failure must never cost a
      Business its credential, because re-obtaining one needs a human at a
      consent screen.
    */
    if (body?.error === "invalid_grant") await forgetAccess(businessId);
    else {
      console.error(
        `Google refused to refresh ${businessId} (${response.status}${
          body?.error ? `: ${body.error}` : ""
        })`,
      );
    }
    return null;
  }

  /*
    Note what is NOT done here: storing a new refresh token. Google only returns
    one when `access_type=offline` was set on the original authorisation, and a
    refresh response normally carries none at all. Its absence is the documented
    normal case, not a signal, so the stored token stays as it is.
  */
  if (!body?.access_token) {
    console.error(`Google returned no access_token for ${businessId}`);
    return null;
  }

  return body.access_token;
}

/**
 * The designed state ADR-0004 asks for when access is gone.
 *
 * `clearGoogleConnection` is reused rather than reimplemented — it is the one
 * statement in the codebase that empties those two columns, and a second one
 * would be a second thing to keep in step. The stamp is what lets Settings say
 * *why* the connection vanished instead of silently offering Connect again.
 */
async function forgetAccess(businessId: string): Promise<void> {
  await clearGoogleConnection(businessId);
  await db
    .update(schema.businesses)
    .set({ googleAccessLostAt: new Date() })
    .where(eq(schema.businesses.id, businessId));
}
