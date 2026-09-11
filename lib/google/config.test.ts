import { describe, expect, it } from "vitest";

import {
  GOOGLE_CALLBACK_PATH,
  googleCalendarConfigured,
  googleRedirectUri,
} from "@/lib/google/config";

/*
  The env arrives as an argument throughout, so nothing here reads or mutates
  `process.env` — these assertions hold identically on a machine with a real
  Google client id in .env.local and on one without.
*/
const FULL = {
  GOOGLE_CLIENT_ID: "1234.apps.googleusercontent.example",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

describe("googleCalendarConfigured", () => {
  it("is true only with all three variables", () => {
    expect(googleCalendarConfigured(FULL)).toBe(true);
  });

  it.each(Object.keys(FULL))("is false without %s", (missing) => {
    // TOKEN_ENCRYPTION_KEY counts as much as the client credentials: without it
    // the handshake could only finish by writing the refresh token in plaintext,
    // which SPEC.md §5 forbids, or by failing after the user has already
    // consented at Google.
    expect(googleCalendarConfigured({ ...FULL, [missing]: undefined })).toBe(false);
  });

  it("treats blank and whitespace-only as unset", () => {
    // The shape a `.env` file with `GOOGLE_CLIENT_ID=` produces.
    expect(googleCalendarConfigured({ ...FULL, GOOGLE_CLIENT_ID: "" })).toBe(false);
    expect(googleCalendarConfigured({ ...FULL, GOOGLE_CLIENT_SECRET: "   " })).toBe(false);
  });

  it("is false, not throwing, on an empty environment", () => {
    // ADR-0004: Callzie must be fully functional for a deployment that never
    // configures Google.
    expect(googleCalendarConfigured({})).toBe(false);
  });
});

describe("googleRedirectUri", () => {
  it("appends the callback path to APP_URL", () => {
    expect(googleRedirectUri({ APP_URL: "https://callzie.example.test" })).toBe(
      `https://callzie.example.test${GOOGLE_CALLBACK_PATH}`,
    );
  });

  it("strips a trailing slash", () => {
    // `//api/google/callback` resolves to the same route but is a different
    // string to Google, which compares redirect_uri byte for byte against the
    // value registered in the Cloud console.
    expect(googleRedirectUri({ APP_URL: "https://callzie.example.test/" })).toBe(
      `https://callzie.example.test${GOOGLE_CALLBACK_PATH}`,
    );
    expect(googleRedirectUri({ APP_URL: "https://callzie.example.test///" })).toBe(
      `https://callzie.example.test${GOOGLE_CALLBACK_PATH}`,
    );
  });

  it("falls back to the local default documented in .env.example", () => {
    expect(googleRedirectUri({})).toBe(`http://localhost:3000${GOOGLE_CALLBACK_PATH}`);
  });

  it("matches the route file's own path", () => {
    // If `app/api/google/callback/route.ts` moves, this constant has to move
    // with it or the consent screen 404s on the way back.
    expect(GOOGLE_CALLBACK_PATH).toBe("/api/google/callback");
  });
});
