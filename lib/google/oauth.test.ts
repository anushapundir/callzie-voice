import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  GOOGLE_CALENDAR_LIST_SCOPE,
  GOOGLE_CALENDAR_SCOPE,
  GOOGLE_OAUTH_SCOPES,
  PRIMARY_CALENDAR_ALIAS,
  STATE_TTL_MS,
  buildConsentUrl,
  exchangeCodeForTokens,
  fetchPrimaryCalendarId,
  signState,
  verifyState,
} from "@/lib/google/oauth";

/*
  No live Google call anywhere in this file, and none is possible: every function
  that talks to Google takes its `fetch` as an argument and every test supplies a
  fake. SPEC.md §3 rule 11 forbids placing real Calls from the test suite; a
  third-party OAuth endpoint that rate-limits and needs a human at a consent
  screen is the same problem with the same answer.

  The secrets below are obviously fake so a real INTERNAL_SECRET can never reach
  the repo through this suite.
*/
const SECRET = "test-internal-secret";
const CLIENT_ID = "1234.apps.googleusercontent.example";
const CLIENT_SECRET = "test-client-secret";
const REDIRECT_URI = "https://callzie.example.test/api/google/callback";
const BUSINESS_ID = "11111111-2222-3333-4444-555555555555";

/** A `fetch` that answers once with a fixed body and records what it was asked. */
function fakeFetch(
  status: number,
  body: unknown,
): typeof fetch & { calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return Object.assign(impl as unknown as typeof fetch, { calls });
}

describe("buildConsentUrl", () => {
  const params = new URL(
    buildConsentUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT_URI, state: "STATE" }),
  ).searchParams;

  it("points at Google's current authorization endpoint", () => {
    const url = new URL(
      buildConsentUrl({ clientId: CLIENT_ID, redirectUri: REDIRECT_URI, state: "S" }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  });

  it("asks for an authorization code bound to our redirect", () => {
    expect(params.get("response_type")).toBe("code");
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(params.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(params.get("state")).toBe("STATE");
  });

  it("sets access_type=offline and prompt=consent", () => {
    // Together these are the only reason a refresh token ever arrives. Without
    // `offline` Google issues none at all; without `consent` it issues none on
    // any authorisation after the first — a 200 OK that silently lacks the one
    // field the flow exists to obtain.
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("prompt")).toBe("consent");
  });

  it("requests the events scope plus the narrowest calendar-list read", () => {
    const scopes = (params.get("scope") ?? "").split(" ");

    expect(scopes).toContain(GOOGLE_CALENDAR_SCOPE);
    // `calendar.events` is NOT an accepted scope for calendarList.get, so
    // requesting it alone makes the primary-calendar read a guaranteed 403.
    expect(scopes).toContain(GOOGLE_CALENDAR_LIST_SCOPE);
    expect(scopes).toEqual([...GOOGLE_OAUTH_SCOPES]);
  });

  it("keeps previously granted scopes", () => {
    expect(params.get("include_granted_scopes")).toBe("true");
  });

  it("asks for nothing broader than it needs", () => {
    // A regression guard on scope creep: the full-control `calendar` scope
    // grants calendar deletion and sharing, which ADR-0004's one-way push never
    // needs and which raises the verification bar.
    for (const scope of GOOGLE_OAUTH_SCOPES) {
      expect(scope).not.toBe("https://www.googleapis.com/auth/calendar");
    }
  });
});

describe("signState / verifyState", () => {
  const now = new Date("2026-08-14T10:00:00Z");
  const fresh = () =>
    signState(
      { businessId: BUSINESS_ID, nonce: "abc123", expiresAt: now.getTime() + STATE_TTL_MS },
      SECRET,
    );

  it("accepts a state it just signed and returns the Business it was minted for", () => {
    expect(verifyState(fresh(), SECRET, now)).toEqual({ ok: true, businessId: BUSINESS_ID });
  });

  it("survives a round trip through a URL query string", () => {
    // The state travels to Google and back as a query parameter; an encoding
    // that mangles it would fail closed and look like an attack.
    const state = fresh();
    const round = new URL(`https://x.test/?state=${encodeURIComponent(state)}`).searchParams.get(
      "state",
    );
    expect(round).toBe(state);
    expect(verifyState(round ?? "", SECRET, now).ok).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const other = "99999999-8888-7777-6666-555555555555";
    const [, mac] = fresh().split(".");
    const forged = `${Buffer.from(`${other}|abc123|${now.getTime() + STATE_TTL_MS}`).toString(
      "base64url",
    )}.${mac}`;

    // Re-pointing the state at another Business is the exact CSRF this guards.
    expect(verifyState(forged, SECRET, now)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered signature", () => {
    const [payload, mac] = fresh().split(".");
    const flipped = `${payload}.${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`;

    expect(verifyState(flipped, SECRET, now)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a signature of a different length without throwing", () => {
    // `timingSafeEqual` throws on a length mismatch, and the candidate here is
    // attacker-controlled — unguarded, a forged state becomes a 500.
    const [payload] = fresh().split(".");
    expect(verifyState(`${payload}.short`, SECRET, now)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a state signed with a different secret", () => {
    expect(verifyState(fresh(), "some-other-secret", now)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects an expired state", () => {
    const justPast = new Date(now.getTime() + STATE_TTL_MS + 1);
    expect(verifyState(fresh(), SECRET, justPast)).toEqual({ ok: false, reason: "expired" });
  });

  it("treats the expiry instant itself as expired", () => {
    expect(verifyState(fresh(), SECRET, new Date(now.getTime() + STATE_TTL_MS))).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("gives the consent screen about ten minutes", () => {
    expect(STATE_TTL_MS).toBe(10 * 60 * 1000);
  });

  it("rejects malformed input rather than throwing", () => {
    for (const bad of ["", "nodot", "a.b.c", "....", "!!!.???"]) {
      expect(verifyState(bad, SECRET, now).ok).toBe(false);
    }
  });

  it("rejects a validly signed payload of the wrong shape", () => {
    // Signed by us, so it passes the MAC — but two fields, not three. A verified
    // signature says who wrote a value, never that its shape is what we expect,
    // and `verifyState` has to check both before believing any field.
    const encoded = `${BUSINESS_ID}|abc123`;
    const mac = createHmac("sha256", SECRET).update(encoded).digest("base64url");
    const state = `${Buffer.from(encoded).toString("base64url")}.${mac}`;

    expect(verifyState(state, SECRET, now)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a validly signed payload with a non-numeric expiry", () => {
    const encoded = `${BUSINESS_ID}|abc123|never`;
    const mac = createHmac("sha256", SECRET).update(encoded).digest("base64url");
    const state = `${Buffer.from(encoded).toString("base64url")}.${mac}`;

    expect(verifyState(state, SECRET, now)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("exchangeCodeForTokens", () => {
  const opts = {
    code: "4/0AY0e-code",
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
  };

  it("posts a form-encoded authorization_code grant to Google's token endpoint", async () => {
    const impl = fakeFetch(200, { access_token: "at", refresh_token: "rt" });
    await exchangeCodeForTokens(opts, impl);

    const [call] = impl.calls;
    expect(call.url).toBe("https://oauth2.googleapis.com/token");
    expect(call.init?.method).toBe("POST");
    expect(
      (call.init?.headers as Record<string, string>)["Content-Type"],
      // Google answers a JSON body with `invalid_request`, which reads like a
      // bad parameter rather than a bad content type.
    ).toBe("application/x-www-form-urlencoded");

    const body = new URLSearchParams(String(call.init?.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe(opts.code);
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(body.get("client_secret")).toBe(CLIENT_SECRET);
    // Google re-validates this against the authorisation request.
    expect(body.get("redirect_uri")).toBe(REDIRECT_URI);
  });

  it("returns both tokens on success", async () => {
    await expect(
      exchangeCodeForTokens(opts, fakeFetch(200, { access_token: "at", refresh_token: "rt" })),
    ).resolves.toEqual({ accessToken: "at", refreshToken: "rt" });
  });

  it("returns refreshToken: null when Google omits it", async () => {
    // A 200 with no refresh_token — what a repeat authorisation looks like. It
    // has to be distinguishable from success, not coerced into one.
    await expect(
      exchangeCodeForTokens(opts, fakeFetch(200, { access_token: "at" })),
    ).resolves.toEqual({ accessToken: "at", refreshToken: null });
  });

  it("throws on a non-200, naming Google's error but not the body", async () => {
    const impl = fakeFetch(400, { error: "invalid_grant", code: opts.code });

    await expect(exchangeCodeForTokens(opts, impl)).rejects.toThrow(
      /Google token exchange failed \(400: invalid_grant\)/,
    );
    // The authorisation code must never reach a log line.
    await expect(exchangeCodeForTokens(opts, impl)).rejects.not.toThrow(
      new RegExp(opts.code.replace("/", "\\/")),
    );
  });

  it("throws on a non-200 with an unreadable body", async () => {
    const impl = (async () =>
      new Response("<html>502</html>", { status: 502 })) as unknown as typeof fetch;

    await expect(exchangeCodeForTokens(opts, impl)).rejects.toThrow(
      /Google token exchange failed \(502\)/,
    );
  });

  it("throws on a 200 that carries no access token", async () => {
    await expect(exchangeCodeForTokens(opts, fakeFetch(200, {}))).rejects.toThrow(
      /no access_token/,
    );
  });
});

describe("fetchPrimaryCalendarId", () => {
  it("reads the id from calendarList/primary with a bearer token", async () => {
    const impl = fakeFetch(200, { id: "owner@example.test", primary: true });

    await expect(fetchPrimaryCalendarId("at", impl)).resolves.toBe("owner@example.test");

    const [call] = impl.calls;
    expect(call.url).toBe(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList/primary",
    );
    expect((call.init?.headers as Record<string, string>).Authorization).toBe("Bearer at");
  });

  it("falls back to the `primary` alias on a refused read", async () => {
    // 403 is the realistic case: a grant that predates the calendar-list scope,
    // or an owner who unticked it under granular consent. The alias is a valid
    // calendarId on every Calendar API endpoint, so the connection still works —
    // aborting here would throw away the refresh token the user just granted.
    await expect(
      fetchPrimaryCalendarId("at", fakeFetch(403, { error: { code: 403 } })),
    ).resolves.toBe(PRIMARY_CALENDAR_ALIAS);
  });

  it("falls back when the response carries no id", async () => {
    await expect(fetchPrimaryCalendarId("at", fakeFetch(200, {}))).resolves.toBe("primary");
  });

  it("falls back when the body is not JSON", async () => {
    const impl = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
    await expect(fetchPrimaryCalendarId("at", impl)).resolves.toBe("primary");
  });
});
