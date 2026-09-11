import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { googleCalendarConfigured } from "@/lib/google/config";
import { encryptSecret } from "@/lib/google/crypto";
import type { Business } from "@/lib/onboarding/create-business";

/**
 * What Callzie knows about a Business's Google Calendar link, and the only two
 * writes that change it.
 *
 * This is the seam between the OAuth handshake (issue #5) and everything that
 * later reads the connection — the Settings screen now, ADR-0004's one-way push
 * in issue #20. Both of those ask the same two questions and must never confuse
 * them:
 *
 * - **Configured** — does this *deployment* offer Google at all? Answered by
 *   env, identical for every Business, false on any deploy without the three
 *   variables.
 * - **Connected** — has *this* Business completed the handshake? Answered by the
 *   row.
 *
 * Collapsing them is how "connect" buttons end up rendering against a
 * deployment that cannot honour them, and how a push path ends up attempting a
 * refresh with no client credentials. ADR-0004 requires Callzie to be **fully
 * functional for a Business that never connects Google**, so "not configured"
 * and "not connected" are both ordinary states here, never errors.
 *
 * Nothing in this file pushes an event or looks for a Collision — that is issue
 * #20's scope. Issue #5 stores the connection and stops.
 */

/** The connection as a screen needs to see it. */
export type GoogleConnection = {
  /** The deployment has GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY. */
  configured: boolean;
  /** This Business holds a usable refresh token. */
  connected: boolean;
  /** The calendar the connection is bound to, for display. */
  calendarId: string | null;
  /**
   * When Callzie last found the grant gone, if it has not been reconnected
   * since.
   *
   * Only ever set alongside `connected: false`, because the same code path
   * clears the token and writes this. It is what lets Settings say *why* the
   * Connect button is back instead of silently offering it again — the
   * connection expired (Testing-status grants last seven days) or the owner
   * revoked it at myaccount.google.com.
   */
  accessLostAt: Date | null;
};

/**
 * The query parameter the callback reports through, on `/settings`.
 *
 * SPEC.md §11.3 is explicit that failures render as designed states — "a failed
 * parse renders as a designed amber card [...] never an unstyled error". The
 * OAuth callback has no UI of its own and cannot render anything, so every exit
 * from it, successful or not, becomes one of these values on a redirect back to
 * a screen that can.
 */
export const GOOGLE_STATUS_PARAM = "google";

export const GOOGLE_STATUSES = [
  /** The handshake completed and a refresh token is stored. */
  "connected",
  /** The Business cleared its connection from Settings. */
  "disconnected",
  /** The owner pressed Cancel on Google's consent screen. Not an error. */
  "denied",
  /** This deployment has no Google credentials configured. */
  "unavailable",
  /** The `state` was missing, forged, or belonged to a different account. */
  "invalid_state",
  /** The consent screen was left open past the state's ten-minute life. */
  "expired_state",
  /** Google refused the code, or returned a response we could not use. */
  "exchange_failed",
  /**
   * Google issued no refresh token and none was already stored — see the
   * `prompt=consent` note in `lib/google/oauth.ts`. Recoverable only by revoking
   * Callzie's access at myaccount.google.com and reconnecting.
   */
  "no_refresh_token",
] as const;

export type GoogleStatus = (typeof GOOGLE_STATUSES)[number];

/**
 * Plain-language copy for each status, so the callback's `reason` survives the
 * redirect as something a Business owner can act on rather than an enum they
 * have to guess at.
 */
export const GOOGLE_STATUS_MESSAGES: Record<GoogleStatus, string> = {
  connected: "Google Calendar connected.",
  disconnected: "Google Calendar disconnected.",
  denied: "Google Calendar was not connected — the request was cancelled.",
  unavailable:
    "Google Calendar is not configured on this deployment. Callzie works without it.",
  invalid_state:
    "That connection link could not be verified. Start the connection again from this page.",
  expired_state:
    "The connection request timed out. Start the connection again from this page.",
  exchange_failed:
    "Google refused the connection request. Try again in a moment.",
  no_refresh_token:
    "Google did not return the long-lived permission Callzie needs. Remove Callzie " +
    "at myaccount.google.com/permissions, then connect again.",
};

/** Narrows an arbitrary query-string value to a status a screen can render. */
export function asGoogleStatus(value: string | null): GoogleStatus | null {
  return GOOGLE_STATUSES.includes(value as GoogleStatus)
    ? (value as GoogleStatus)
    : null;
}

/**
 * The connection state behind a Business row.
 *
 * Pure — the row is already loaded by `requireBusiness()`, so this adds no
 * query to a page render.
 *
 * Note that `connected` is gated on `configured`. A row can hold a refresh
 * token on a deployment whose `TOKEN_ENCRYPTION_KEY` is absent — a token
 * restored from a backup, or a variable dropped from the environment — and that
 * token cannot be decrypted, so it cannot be used. Reporting it as connected
 * would offer a Business a feature that will fail at the first push. "Not
 * connected" is the truthful answer, and reconnecting is the fix.
 */
export function googleConnection(
  business: Business,
  env: Record<string, string | undefined> = process.env,
): GoogleConnection {
  const configured = googleCalendarConfigured(env);
  const connected = configured && Boolean(business.googleRefreshToken);

  return {
    configured,
    connected,
    calendarId: connected ? business.googleCalendarId : null,
    // Suppressed once a reconnect has happened, so a stale stamp cannot
    // contradict a working connection.
    accessLostAt: connected ? null : (business.googleAccessLostAt ?? null),
  };
}

/**
 * Records a completed handshake.
 *
 * **The encryption happens here, not at the call site.** SPEC.md §5 annotates
 * `google_refresh_token` as "encrypted at rest" (ADR-0009 decides how), and an
 * annotation is only worth
 * as much as the narrowest place that can violate it. Taking the plaintext and
 * sealing it inside the same function that writes the row means there is exactly
 * one statement in the codebase that can put a value in that column, and it
 * cannot put a plaintext one there. A `storeGoogleConnection(id, calendarId,
 * encryptSecret(token))` signature would have read almost the same and left the
 * guarantee to whoever writes the next caller.
 *
 * An UPDATE rather than an upsert: the `businesses` row is created during
 * onboarding and this only ever adds to it. A Business that does not exist is a
 * bug upstream, not a row to create — and the callback reaches here only after
 * `requireBusiness()` has already proven the row exists.
 */
export async function storeGoogleConnection(
  businessId: string,
  calendarId: string,
  refreshToken: string,
): Promise<void> {
  await db
    .update(schema.businesses)
    .set({
      googleCalendarId: calendarId,
      googleRefreshToken: encryptSecret(refreshToken),
      // A successful reconnect ends whatever went wrong last time. Leaving the
      // stamp would keep Settings explaining a failure that no longer applies.
      googleAccessLostAt: null,
    })
    .where(eq(schema.businesses.id, businessId));
}

/**
 * Forgets the connection — the Disconnect action on Settings.
 *
 * Both columns together. Clearing the token but leaving the calendar id would
 * leave Settings displaying a calendar Callzie can no longer reach, which is the
 * kind of half-state ADR-0004's "fully functional without Google" requirement
 * exists to rule out.
 *
 * This does **not** revoke the grant at Google. Callzie's copy of the credential
 * is destroyed, so it can no longer act; the grant itself is the owner's to
 * remove at myaccount.google.com/permissions. Calling Google's revoke endpoint
 * from here would make disconnecting depend on a third party being reachable —
 * a Business that wants Callzie's access gone must not be blocked by Google
 * timing out. Worth revisiting alongside issue #20, when there is a token
 * refresh path to hang it off.
 */
export async function clearGoogleConnection(businessId: string): Promise<void> {
  await db
    .update(schema.businesses)
    .set({ googleCalendarId: null, googleRefreshToken: null })
    .where(eq(schema.businesses.id, businessId));
}
