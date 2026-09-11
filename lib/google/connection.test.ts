import { describe, expect, it } from "vitest";

import {
  GOOGLE_STATUSES,
  GOOGLE_STATUS_MESSAGES,
  asGoogleStatus,
  googleConnection,
} from "@/lib/google/connection";
import type { Business } from "@/lib/onboarding/create-business";

/*
  Only the pure half of the module is exercised here. `storeGoogleConnection`
  and `clearGoogleConnection` are two-line UPDATEs whose behaviour lives in
  Postgres, and this workspace has no database reachable to assert it against —
  they are covered by the same integration suite as the rest of lib/db when one
  is (vitest.config.mts explains why those tests run against real Postgres rather
  than a mock).

  `googleConnection` is the piece worth testing in isolation anyway: it is the
  function every screen calls, and getting it wrong means offering a Business a
  Google feature that cannot work.
*/
const CONFIGURED = {
  GOOGLE_CLIENT_ID: "1234.apps.googleusercontent.example",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
};

function business(overrides: Partial<Business> = {}): Business {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    userId: "99999999-8888-7777-6666-555555555555",
    name: "Test Clinic",
    businessType: "clinic",
    timezone: "Asia/Kolkata",
    callQuota: 5,
    callsUsed: 0,
    phoneCallsEnabled: false,
    inboundEnabled: false,
    inboundQuota: 20,
    inboundCallsUsed: 0,
    emergencyLine: null,
    widgetKey: null,
    widgetOrigins: [],
    widgetDailyCap: 25,
    isAdmin: false,
    googleCalendarId: null,
    googleRefreshToken: null,
    googleAccessLostAt: null,
    createdAt: new Date("2026-08-14T10:00:00Z"),
    ...overrides,
  };
}

describe("googleConnection", () => {
  it("reports a connected Business", () => {
    expect(
      googleConnection(
        business({
          googleCalendarId: "owner@example.test",
          googleRefreshToken: "v1:iv:tag:ciphertext",
        }),
        CONFIGURED,
      ),
    ).toEqual({
      configured: true,
      connected: true,
      calendarId: "owner@example.test",
      accessLostAt: null,
    });
  });

  it("separates 'this deployment offers Google' from 'this Business connected'", () => {
    // The distinction the whole module exists for. A configured deployment with
    // an unconnected Business is the ordinary state, not an error.
    expect(googleConnection(business(), CONFIGURED)).toEqual({
      configured: true,
      connected: false,
      calendarId: null,
      accessLostAt: null,
    });
  });

  it("reports not configured, without throwing, on an empty environment", () => {
    // ADR-0004: Callzie must be fully functional for a Business that never
    // connects Google.
    expect(googleConnection(business(), {})).toEqual({
      configured: false,
      connected: false,
      calendarId: null,
      accessLostAt: null,
    });
  });

  it("reports a stored token as disconnected when the key is gone", () => {
    // A row restored from a backup, or a TOKEN_ENCRYPTION_KEY dropped from the
    // environment. The token cannot be decrypted, so it cannot be used, so
    // "connected" would be a promise the first push would break.
    expect(
      googleConnection(
        business({
          googleCalendarId: "owner@example.test",
          googleRefreshToken: "v1:iv:tag:ciphertext",
        }),
        { ...CONFIGURED, TOKEN_ENCRYPTION_KEY: undefined },
      ),
    ).toEqual({
      configured: false,
      connected: false,
      calendarId: null,
      accessLostAt: null,
    });
  });

  it("hides a stale calendar id left without a token", () => {
    // Half-cleared rows must not render as a calendar Callzie can reach.
    expect(
      googleConnection(business({ googleCalendarId: "owner@example.test" }), CONFIGURED)
        .calendarId,
    ).toBeNull();
  });
});

describe("the status vocabulary", () => {
  it("gives every status human-readable copy", () => {
    // Every exit from the callback is one of these, and each has to reach the
    // owner as something they can act on rather than an enum (SPEC.md §11.3).
    for (const status of GOOGLE_STATUSES) {
      expect(GOOGLE_STATUS_MESSAGES[status].length).toBeGreaterThan(10);
    }
  });

  it("narrows a query-string value to a known status", () => {
    expect(asGoogleStatus("connected")).toBe("connected");
    expect(asGoogleStatus("denied")).toBe("denied");
  });

  it("rejects anything else, so a crafted URL cannot render arbitrary text", () => {
    expect(asGoogleStatus(null)).toBeNull();
    expect(asGoogleStatus("")).toBeNull();
    expect(asGoogleStatus("<script>alert(1)</script>")).toBeNull();
  });
});

describe("googleConnection, after access was lost", () => {
  it("reports when the grant went, so Settings can explain itself", () => {
    /*
      The row a lost grant leaves behind: both Google columns cleared by
      `clearGoogleConnection`, and a stamp saying when. Without surfacing this,
      an owner whose seven-day Testing-status token expired overnight finds the
      Connect button back with no explanation.
    */
    const lostAt = new Date("2026-08-22T09:00:00Z");

    expect(
      googleConnection(business({ googleAccessLostAt: lostAt }), CONFIGURED),
    ).toEqual({
      configured: true,
      connected: false,
      calendarId: null,
      accessLostAt: lostAt,
    });
  });

  it("forgets the stamp once the Business has reconnected", () => {
    // `storeGoogleConnection` nulls the column, but a connected Business must
    // never be described by a stale one even if that write were ever missed.
    expect(
      googleConnection(
        business({
          googleCalendarId: "owner@example.test",
          googleRefreshToken: "v1:iv:tag:ciphertext",
          googleAccessLostAt: new Date("2026-08-22T09:00:00Z"),
        }),
        CONFIGURED,
      ).accessLostAt,
    ).toBeNull();
  });
});
