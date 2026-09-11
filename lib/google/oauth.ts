import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The Google OAuth 2.0 authorization-code handshake, spoken over `fetch`.
 *
 * Scope note first, because it is the thing this file gets right that a
 * from-memory implementation gets wrong. SPEC.md §3 rule 12 requires payloads to
 * be *verified against current Google docs* rather than copied from the spec's
 * descriptive names, and two facts were checked before this was written:
 *
 * 1. `calendar.events` grants "view and edit events on all your calendars" —
 *    everything ADR-0004's one-way push needs, and nothing more. It does **not**
 *    grant sharing or deletion of calendars, which the broader `calendar` scope
 *    does.
 * 2. `calendar.events` is **not** an accepted scope for `calendarList.get` or
 *    `calendars.get`. Both list `calendar`, `calendar.readonly`,
 *    `calendar.app.created` and the two `calendarlist`/`calendars` scopes, and
 *    neither lists `calendar.events`. Requesting only the events scope and then
 *    reading `/users/me/calendarList/primary` returns 403 — the classic way this
 *    integration half-works. `GOOGLE_OAUTH_SCOPES` therefore asks for the
 *    narrowest possible read alongside it, and `fetchPrimaryCalendarId` still
 *    degrades rather than failing if the read is refused.
 *
 * Everything here is either pure or takes an injected `fetchImpl`, so the whole
 * handshake is testable without a network call — SPEC.md §10's rule that all
 * logic must be exercisable against fixtures, applied to OAuth.
 *
 * No `googleapis` dependency: this is four HTTP calls' worth of contract, and
 * the package is an enormous generated surface for that. Same judgement as
 * ADR-0007 on `date-fns-tz`.
 */

/** Google's authorization endpoint — where the browser is sent for consent. */
const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

/**
 * Google's token endpoint. Note the host: `oauth2.googleapis.com`, not
 * `accounts.google.com`. The older `accounts.google.com/o/oauth2/token` form
 * still appears in tutorials and is the wrong one to copy.
 */
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** `calendarList.get`, with Google's alias for "whoever owns this token". */
const GOOGLE_CALENDAR_LIST_ENDPOINT =
  "https://www.googleapis.com/calendar/v3/users/me/calendarList/primary";

/**
 * The scope ADR-0004's one-way push runs on: read and write events, on the
 * user's own calendars. Issue #20 writes with this; issue #5 only obtains it.
 */
export const GOOGLE_CALENDAR_SCOPE =
  "https://www.googleapis.com/auth/calendar.events";

/**
 * A read-only view of *which* calendars exist, requested only so the connect
 * flow can record which one it is bound to.
 *
 * `calendar.calendarlist.readonly` is the narrowest scope Google offers that
 * authorises `calendarList.get`; the alternatives (`calendar`,
 * `calendar.readonly`) both grant far more than "tell me the address of the
 * primary calendar". Asking for it here is what turns the stored
 * `google_calendar_id` into a real address the owner recognises on the Settings
 * screen instead of an opaque alias.
 */
export const GOOGLE_CALENDAR_LIST_SCOPE =
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly";

/** Every scope the consent screen asks for, in the order Google displays them. */
export const GOOGLE_OAUTH_SCOPES = [
  GOOGLE_CALENDAR_SCOPE,
  GOOGLE_CALENDAR_LIST_SCOPE,
] as const;

/**
 * Google's alias for the signed-in account's own calendar, valid as a
 * `calendarId` path segment on every Calendar API endpoint.
 *
 * The fallback when the calendar list cannot be read: it is always correct for
 * writing events, it just says nothing a human would recognise.
 */
export const PRIMARY_CALENDAR_ALIAS = "primary";

/** How long a signed `state` stays valid. */
export const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * The URL that sends a Business owner to Google's consent screen.
 *
 * Two parameters carry the entire success or failure of this feature:
 *
 * - **`access_type=offline`** is what makes Google issue a refresh token at all.
 *   Without it the response carries an access token that expires in an hour and
 *   nothing that can renew it — fine for a user sitting in front of the browser,
 *   useless for ADR-0004's push, which happens whenever an Appointment is
 *   booked, not when anyone is watching.
 * - **`prompt=consent`** is the one everybody omits. Google issues a refresh
 *   token on the *first* authorisation of a given client/user pair and, on every
 *   subsequent one, returns an access token with **no `refresh_token` field at
 *   all** — a 200 OK that quietly lacks the only thing the flow was for. It bites
 *   during development (connect, disconnect, reconnect) and in production (a
 *   Business reconnecting after clearing the row). Forcing the consent screen
 *   makes Google re-issue every time, so reconnecting is never a silent no-op.
 *   `lib/google/connection.ts` and the callback still handle the absent-token
 *   case, because "we set the flag" is not a guarantee.
 *
 * `include_granted_scopes=true` is Google's incremental-authorisation flag: a
 * token issued here also carries any scope this user previously granted Callzie,
 * so a later feature asking for one more scope does not silently revoke the
 * calendar access this one obtained.
 */
export function buildConsentUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    // Space-delimited, per the spec. URLSearchParams encodes the spaces.
    scope: GOOGLE_OAUTH_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: opts.state,
  }).toString();

  return url.toString();
}

/** What the `state` parameter carries there and back. */
export type StatePayload = {
  businessId: string;
  /** Random per authorisation, so two states are never byte-identical. */
  nonce: string;
  /** Epoch milliseconds. */
  expiresAt: number;
};

/**
 * `state`, signed — CSRF protection for a callback URL the whole internet can
 * reach.
 *
 * `/api/google/callback` is a GET endpoint that performs a write. Without this,
 * anyone could send a signed-in owner to it carrying an authorisation code from
 * *their* Google account and bind the victim's Business to the attacker's
 * calendar — every future Appointment pushed somewhere the owner cannot see.
 * OAuth's answer is that the callback must prove it is completing a flow this
 * app started, and `state` is the only channel available for that.
 *
 * An HMAC rather than a server-side nonce table because it needs no storage and
 * no cleanup, and rather than a plain random cookie because it also *binds the
 * flow to a Business* — the callback can check that the account finishing the
 * handshake is the account that began it.
 *
 * Keyed on `INTERNAL_SECRET`, the secret this repo already uses to authenticate
 * its own machine-to-machine calls (.env.example, §7). Note the consequence:
 * rotating it invalidates in-flight consent flows, which self-heals in ten
 * minutes and is the correct behaviour for a rotation.
 *
 * Format: `base64url(payload) + "." + base64url(mac)`. base64url so it survives
 * the round trip through Google's redirect untouched, and a `.` separator
 * because base64url's alphabet excludes it.
 */
export function signState(payload: StatePayload, secret: string): string {
  const encoded = encodeStatePayload(payload);
  return `${Buffer.from(encoded, "utf8").toString("base64url")}.${macOf(
    encoded,
    secret,
  )}`;
}

/**
 * Whether `state` was signed by us, for whom, and whether it is still alive.
 *
 * The order of the checks is the security-relevant part: signature **before**
 * expiry, and both before the payload is believed. An expired-but-valid state
 * and a forged one are different situations, and reporting expiry for an
 * unverified payload would be reporting a value an attacker chose.
 *
 * `reason` is for the Settings screen, not for the attacker — the callback maps
 * it to a status query parameter, never to a stack trace (SPEC.md §11.3: failure
 * states are designed, never unstyled).
 */
export function verifyState(
  state: string,
  secret: string,
  now: Date,
): { ok: true; businessId: string } | { ok: false; reason: string } {
  const parts = state.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };

  const [encodedPart, macPart] = parts;
  const encoded = Buffer.from(encodedPart, "base64url").toString("utf8");

  if (!macsEqual(macOf(encoded, secret), macPart)) {
    return { ok: false, reason: "bad_signature" };
  }

  // Only now is the payload trustworthy enough to parse.
  const fields = encoded.split("|");
  if (fields.length !== 3) return { ok: false, reason: "malformed" };

  const [businessId, , expiresAtRaw] = fields;
  const expiresAt = Number(expiresAtRaw);
  if (!businessId || !Number.isFinite(expiresAt)) {
    return { ok: false, reason: "malformed" };
  }

  if (now.getTime() >= expiresAt) return { ok: false, reason: "expired" };

  return { ok: true, businessId };
}

/**
 * The exact bytes the MAC covers. `|` cannot appear in a UUID, a hex nonce or a
 * number, so no field can be made to impersonate another by choosing its
 * contents — and `verifyState` rejects anything that does not split into exactly
 * three fields regardless.
 */
function encodeStatePayload(payload: StatePayload): string {
  return `${payload.businessId}|${payload.nonce}|${payload.expiresAt}`;
}

function macOf(encoded: string, secret: string): string {
  return createHmac("sha256", secret).update(encoded).digest("base64url");
}

/**
 * Constant-time comparison, with the guard that makes it usable.
 *
 * `timingSafeEqual` **throws** when the two buffers differ in length, and the
 * candidate here is attacker-controlled — so the naive call turns a forged state
 * into a 500 instead of a rejection. Comparing lengths first is safe: the length
 * of an HMAC-SHA256 digest is public, so leaking it leaks nothing.
 */
function macsEqual(expected: string, candidate: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(candidate, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Trades the one-time authorisation code for tokens.
 *
 * `refreshToken` is typed `string | null` because Google genuinely omits it —
 * see the `prompt=consent` note above. Modelling it as optional here forces the
 * caller to decide what an absent one means rather than writing `undefined` into
 * a column SPEC.md §5 expects to hold a credential.
 *
 * The `redirect_uri` is sent again even though Google already has the code:
 * Google re-validates it against the authorisation request and rejects a
 * mismatch. Both callers take it from `googleRedirectUri()` so the two cannot
 * disagree.
 *
 * A non-200 throws with Google's `error` field but **never with the response
 * body verbatim** — the body of a token exchange can echo the code, and this
 * message ends up in a server log.
 *
 * `fetchImpl` is injected so tests exercise every branch without a live call.
 * SPEC.md §3 rule 11 forbids real Calls in tests; the same logic applies to a
 * third-party OAuth endpoint that rate-limits and requires a real consent.
 */
export async function exchangeCodeForTokens(
  opts: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string; refreshToken: string | null }> {
  const response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    // Form-encoded, not JSON. Google's token endpoint rejects a JSON body with
    // `invalid_request`, which reads like a bad parameter rather than a bad
    // content type.
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: opts.code,
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });

  const body = (await response.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    error?: string;
  } | null;

  if (!response.ok) {
    throw new Error(
      `Google token exchange failed (${response.status}${
        body?.error ? `: ${body.error}` : ""
      })`,
    );
  }

  if (!body?.access_token) {
    // A 200 with no token is not success. Treating it as one would store an
    // empty credential and defer the failure to the first push.
    throw new Error("Google token exchange returned no access_token");
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
  };
}

/**
 * The address of the account's primary calendar — typically their email — for
 * display on Settings and as the `calendarId` issue #20 writes events to.
 *
 * **Degrades instead of failing.** If the calendar list cannot be read for any
 * reason — the grant predates `GOOGLE_CALENDAR_LIST_SCOPE`, granular consent let
 * the owner untick it, Google is having a bad minute — this returns Google's
 * `primary` alias, which is a valid `calendarId` on every Calendar API endpoint
 * including `events.insert`. That is the whole reason this read is allowed to be
 * lossy: the id it produces is a *label*, and the connection works without a
 * pretty one. Aborting the handshake over it would throw away the refresh token
 * the user just granted and send them back to the consent screen for nothing.
 *
 * The access token is used once, here, and never stored. Only the refresh token
 * is persisted (SPEC.md §5); an access token lives an hour and storing it would
 * add a second secret to protect for no benefit.
 */
export async function fetchPrimaryCalendarId(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(GOOGLE_CALENDAR_LIST_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) return PRIMARY_CALENDAR_ALIAS;

  const body = (await response.json().catch(() => null)) as {
    id?: string;
  } | null;

  return body?.id ?? PRIMARY_CALENDAR_ALIAS;
}
