import { afterEach, describe, expect, it, vi } from "vitest";

import { isAuthorised } from "@/lib/tools/auth";

/*
  Acceptance criterion 1: each endpoint is reachable only with the internal
  secret, and rejects unauthenticated calls.

  Both headers are accepted because docs/verification.md A12 records it as
  UNVERIFIED whether Retell forwards `Authorization` unmodified, and names
  `X-Callzie-Secret` as the fallback. Finding out during a live call would mean
  re-provisioning four Agents to fix it.
*/

const SECRET = "test-internal-secret-value";

function post(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/tools/check-availability", {
    method: "POST",
    headers,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isAuthorised", () => {
  it("accepts the secret as a Bearer token", () => {
    vi.stubEnv("INTERNAL_SECRET", SECRET);
    expect(isAuthorised(post({ Authorization: `Bearer ${SECRET}` }))).toBe(true);
  });

  it("accepts the secret in X-Callzie-Secret", () => {
    vi.stubEnv("INTERNAL_SECRET", SECRET);
    expect(isAuthorised(post({ "X-Callzie-Secret": SECRET }))).toBe(true);
  });

  it("accepts a lower-case bearer scheme", () => {
    // RFC 7235 makes the scheme token case-insensitive, and a proxy that
    // rewrites it is not a request to refuse.
    vi.stubEnv("INTERNAL_SECRET", SECRET);
    expect(isAuthorised(post({ Authorization: `bearer ${SECRET}` }))).toBe(true);
  });

  it("refuses a request with no credential at all", () => {
    vi.stubEnv("INTERNAL_SECRET", SECRET);
    expect(isAuthorised(post({}))).toBe(false);
  });

  it("refuses the wrong secret", () => {
    vi.stubEnv("INTERNAL_SECRET", SECRET);
    expect(isAuthorised(post({ Authorization: "Bearer not-the-secret" }))).toBe(false);
  });

  it("refuses a secret that is merely a prefix of the real one", () => {
    // The comparison is constant-time over a fixed-length digest, so neither the
    // length of the real secret nor how much of it is right can be measured.
    vi.stubEnv("INTERNAL_SECRET", SECRET);
    expect(isAuthorised(post({ Authorization: `Bearer ${SECRET.slice(0, -1)}` }))).toBe(
      false,
    );
  });

  it("refuses a much longer guess without throwing", () => {
    // timingSafeEqual throws on a length mismatch. Hashing first is what turns
    // that into a plain false.
    vi.stubEnv("INTERNAL_SECRET", SECRET);
    expect(() => isAuthorised(post({ Authorization: `Bearer ${"x".repeat(500)}` }))).not.toThrow();
    expect(isAuthorised(post({ Authorization: `Bearer ${"x".repeat(500)}` }))).toBe(false);
  });

  it("refuses an Authorization header that is not a Bearer token", () => {
    vi.stubEnv("INTERNAL_SECRET", SECRET);
    expect(isAuthorised(post({ Authorization: SECRET }))).toBe(false);
  });

  it("refuses everything when INTERNAL_SECRET is unset", () => {
    // A blank secret must never mean "no gate". Same reasoning
    // app/api/google/start/route.ts gives for refusing to start a handshake it
    // cannot sign.
    vi.stubEnv("INTERNAL_SECRET", "");
    expect(isAuthorised(post({ Authorization: "Bearer anything" }))).toBe(false);
    expect(isAuthorised(post({ "X-Callzie-Secret": "anything" }))).toBe(false);
  });

  it("refuses a blank credential against a real secret", () => {
    vi.stubEnv("INTERNAL_SECRET", SECRET);
    expect(isAuthorised(post({ "X-Callzie-Secret": "   " }))).toBe(false);
  });
});
