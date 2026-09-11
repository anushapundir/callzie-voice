import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import { encryptSecret } from "@/lib/google/crypto";
import { accessTokenFor } from "@/lib/google/token";
import { cleanupToolTest, seedToolTest } from "@/lib/tools/testing";

/*
  ADR-0004's push runs whenever an Appointment is booked, which is whenever a
  Call happens rather than whenever somebody is watching. So every branch here
  is a decision made unattended, and the one that matters most is which failures
  are allowed to destroy a credential.

  Only `invalid_grant` is. Everything else leaves the stored token exactly as it
  was, because re-obtaining one needs a human at a consent screen.

  No test reaches Google — SPEC.md §3 rule 11 forbids real Calls and the same
  reasoning covers an API that rate-limits and needs a live consent.
*/

const CLERK_ID = "google-token-test";
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

let businessId: string;

/** Records every request so a test can assert Google was not called at all. */
function fakeFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    const asString = typeof url === "string" ? url : url.toString();
    calls.push({ url: asString, init });
    return Promise.resolve(handler(asString, init));
  }) as unknown as typeof fetch;

  return { impl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The token as it sits in Postgres: encrypted, never plaintext (ADR-0009). */
async function connect(refreshToken = "1//real-refresh-token"): Promise<void> {
  await db
    .update(schema.businesses)
    .set({
      googleCalendarId: "owner@example.test",
      googleRefreshToken: encryptSecret(refreshToken, KEY),
      googleAccessLostAt: null,
    })
    .where(eq(schema.businesses.id, businessId));
}

async function businessRow() {
  const row = await db.query.businesses.findFirst({
    where: eq(schema.businesses.id, businessId),
  });
  if (!row) throw new Error("fixture business vanished");
  return row;
}

beforeAll(async () => {
  await cleanupToolTest(CLERK_ID);
  const seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: new Date("2026-09-01T04:30:00Z"),
  });
  businessId = seed.businessId;
});

afterAll(async () => {
  await cleanupToolTest(CLERK_ID);
});

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "1234.apps.googleusercontent.example";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  process.env.TOKEN_ENCRYPTION_KEY = KEY;
});

describe("accessTokenFor", () => {
  it("refreshes a stored token and returns the calendar with it", async () => {
    await connect();
    const { impl, calls } = fakeFetch(() =>
      json({ access_token: "ya29.fresh", expires_in: 3599 }),
    );

    expect(await accessTokenFor(businessId, impl)).toEqual({
      accessToken: "ya29.fresh",
      calendarId: "owner@example.test",
    });

    /*
      The wire format, verified against Google's docs on 2026-08-23. Form-encoded
      rather than JSON: the token endpoint rejects a JSON body with
      `invalid_request`, which reads like a bad parameter rather than a bad
      content type.
    */
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(calls[0].init?.method).toBe("POST");
    expect(
      (calls[0].init?.headers as Record<string, string>)["Content-Type"],
    ).toBe("application/x-www-form-urlencoded");

    const sent = new URLSearchParams(calls[0].init?.body as string);
    expect(sent.get("grant_type")).toBe("refresh_token");
    expect(sent.get("refresh_token")).toBe("1//real-refresh-token");
    expect(sent.get("client_id")).toBe("1234.apps.googleusercontent.example");
    expect(sent.get("client_secret")).toBe("test-client-secret");
  });

  it("falls back to the primary alias when no calendar id was recorded", async () => {
    await connect();
    await db
      .update(schema.businesses)
      .set({ googleCalendarId: null })
      .where(eq(schema.businesses.id, businessId));

    const { impl } = fakeFetch(() => json({ access_token: "ya29.fresh" }));

    // `primary` is valid on every Calendar API endpoint, so an unread calendar
    // list costs a pretty label and nothing else.
    expect(await accessTokenFor(businessId, impl)).toEqual({
      accessToken: "ya29.fresh",
      calendarId: "primary",
    });
  });

  it("forgets the connection when Google says invalid_grant", async () => {
    /*
      Two causes, one handling. The owner revoked access at
      myaccount.google.com, OR the seven-day Testing-status refresh token simply
      expired — ADR-0004 ships in Testing status on purpose, so the second is
      the ordinary weekly case. Both mean "reconnect", so both land here.
    */
    await connect();
    const { impl } = fakeFetch(() =>
      json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400),
    );

    expect(await accessTokenFor(businessId, impl)).toBeNull();

    const row = await businessRow();
    expect(row.googleRefreshToken).toBeNull();
    expect(row.googleCalendarId).toBeNull();
    expect(row.googleAccessLostAt).toBeInstanceOf(Date);
  });

  it("keeps the credential when Google merely breaks", async () => {
    /*
      The assertion this file exists for. A 500 is transient, and destroying the
      token would turn five minutes of Google downtime into a permanent
      disconnection that only a human at a consent screen can undo.
    */
    await connect();
    const { impl } = fakeFetch(() => json({ error: "backendError" }, 500));

    expect(await accessTokenFor(businessId, impl)).toBeNull();

    const row = await businessRow();
    expect(row.googleRefreshToken).not.toBeNull();
    expect(row.googleAccessLostAt).toBeNull();
  });

  it("keeps the credential when Google cannot be reached at all", async () => {
    await connect();
    const impl = (() =>
      Promise.reject(new Error("ECONNRESET"))) as unknown as typeof fetch;

    expect(await accessTokenFor(businessId, impl)).toBeNull();
    expect((await businessRow()).googleRefreshToken).not.toBeNull();
  });

  it("leaves the stored token alone when the response carries no new one", async () => {
    /*
      A refresh response normally has NO `refresh_token` field — Google returns
      one only when `access_type=offline` was set on the original authorisation.
      Its absence is the documented normal case, not a signal to re-store or
      clear anything.
    */
    await connect();
    const before = (await businessRow()).googleRefreshToken;
    const { impl } = fakeFetch(() => json({ access_token: "ya29.fresh" }));

    await accessTokenFor(businessId, impl);

    expect((await businessRow()).googleRefreshToken).toBe(before);
  });

  it("returns null without calling Google when the Business never connected", async () => {
    await db
      .update(schema.businesses)
      .set({ googleRefreshToken: null, googleCalendarId: null })
      .where(eq(schema.businesses.id, businessId));

    const { impl, calls } = fakeFetch(() => json({ access_token: "no" }));

    expect(await accessTokenFor(businessId, impl)).toBeNull();
    // ADR-0004: a Business that never connects Google costs nothing at all.
    expect(calls).toHaveLength(0);
  });

  it("returns null without calling Google when the deployment is unconfigured", async () => {
    await connect();
    delete process.env.GOOGLE_CLIENT_ID;

    const { impl, calls } = fakeFetch(() => json({ access_token: "no" }));

    expect(await accessTokenFor(businessId, impl)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null without calling Google when the token cannot be decrypted", async () => {
    /*
      A wrong TOKEN_ENCRYPTION_KEY. Not cleared, deliberately: the ciphertext is
      still good and a restored key would still decrypt it, so destroying the
      row would turn a recoverable misconfiguration into a permanent one.
    */
    await connect();
    process.env.TOKEN_ENCRYPTION_KEY =
      "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";

    const { impl, calls } = fakeFetch(() => json({ access_token: "no" }));

    expect(await accessTokenFor(businessId, impl)).toBeNull();
    expect(calls).toHaveLength(0);
    expect((await businessRow()).googleRefreshToken).not.toBeNull();
  });
});
