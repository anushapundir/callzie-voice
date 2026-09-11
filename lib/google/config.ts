/**
 * The flag that decides whether Callzie offers a Google Calendar connection at
 * all, and the one URL both halves of the OAuth handshake must agree on.
 *
 * ADR-0004 ships this integration **behind a flag with the Google app in
 * Testing status**, and states the hard constraint the rest of this directory is
 * built around: *"Callzie must be fully functional for a Business that never
 * connects Google."* Nothing here throws when Google is unconfigured — the flag
 * reads `false`, Settings renders the connection as unavailable, and every other
 * screen behaves as if the feature did not exist. Availability is computed
 * entirely from Callzie's Postgres (SPEC.md §6), so an absent Google costs the
 * product nothing.
 *
 * The env is an argument rather than a direct `process.env` read so the flag can
 * be exercised from a test without mutating global state — the same shape
 * `lib/retell/flags.ts` uses, and for the same reason.
 */

/**
 * Deliberately not `NodeJS.ProcessEnv`: Next widens that type to require
 * NODE_ENV, which would force every caller in a test to supply a value that has
 * nothing to do with Google.
 */
type Env = Record<string, string | undefined>;

/**
 * Whether the Google Calendar integration is switched on for this deployment.
 *
 * All three variables, not two. `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
 * are what the handshake needs, but `TOKEN_ENCRYPTION_KEY` is what makes the
 * result *storable*: SPEC.md §5 annotates `businesses.google_refresh_token` as
 * "encrypted at rest", and a refresh token is a long-lived credential to a
 * third party's calendar. Without a key, the only ways to finish the handshake
 * are to write the token in plaintext or to fail after the user has already
 * granted consent at Google. Refusing to start is the honest option, so the key
 * is part of the flag rather than a check further down the path.
 */
export function googleCalendarConfigured(env: Env = process.env): boolean {
  // Blank and whitespace-only read as unset — `GOOGLE_CLIENT_ID=` is what
  // copying `.env.example` produces, and a value of `""` would otherwise send
  // someone to a consent screen for a client id that does not exist. Matches
  // `lib/settings/env-status.ts`, which reports the same variables to the owner.
  return [
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.TOKEN_ENCRYPTION_KEY,
  ].every((value) => (value ?? "").trim().length > 0);
}

/** The path `app/api/google/callback/route.ts` is served from. */
export const GOOGLE_CALLBACK_PATH = "/api/google/callback";

/**
 * Where Google sends the browser back after consent.
 *
 * Derived in one place because it has to be **byte-identical in three**: the
 * `redirect_uri` on the consent URL, the `redirect_uri` on the token exchange
 * (Google re-checks it there and rejects a mismatch with `redirect_uri_mismatch`),
 * and the "Authorized redirect URI" typed into the Google Cloud console by hand.
 * Two of those are ours; computing them separately is how they drift.
 *
 * The trailing-slash strip matters for the same reason — `APP_URL` with a slash
 * would produce `//api/google/callback`, which is a *different* string to Google
 * even though it resolves to the same route, and the failure surfaces as a
 * console-configuration error rather than as a typo.
 *
 * Falls back to the local default documented in `.env.example` rather than
 * throwing: this is reachable from Settings (to display what to register), and
 * an unset APP_URL in local development must not take a screen down. In
 * production the deploy always sets it, and a wrong value cannot cause a silent
 * mis-send — Google refuses any redirect_uri that is not registered.
 */
export function googleRedirectUri(env: Env = process.env): string {
  const appUrl = (env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${appUrl}${GOOGLE_CALLBACK_PATH}`;
}
