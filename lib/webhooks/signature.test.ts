import { afterEach, describe, expect, it, vi } from "vitest";

import {
  describeSignature,
  signPayload,
  verifySignature,
} from "@/lib/webhooks/signature";

/*
  The gate on the webhook, and the single most dangerous file in this ticket.

  docs/verification.md A8 lists four ways to get this wrong. Three of them are
  tested here — the async trap, the 5-minute replay window, and an unconfigured
  secret. The fourth (verifying a re-serialised body instead of the raw one) is
  not testable in this file, because the mistake happens at the call site: it is
  the route that must read `request.text()` and never `request.json()`. See
  app/api/webhooks/retell/route.test.ts.

  No network, no database, no environment. Every secret here is invented in this
  file, so no real RETELL_API_KEY can make a test pass or fail.
*/

const SECRET = "retell-api-key-for-tests-only";
const BODY = JSON.stringify({ event: "call_ended", call: { call_id: "abc" } });

// Restored even when a test throws, so one failure cannot leave the rest of the
// file reading a stubbed environment.
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("signPayload / verifySignature", () => {
  it("accepts a body signed with the same secret", async () => {
    const signature = await signPayload(BODY, SECRET);

    expect(await verifySignature(BODY, signature, SECRET)).toBe("ok");
  });

  /*
    The forged-payload case, and the whole point of the gate. Anyone can POST to
    this URL — it is public in proxy.ts by necessity, because a machine caller
    has no session cookie. The signature is the only thing standing between the
    internet and a Call row.
  */
  it("refuses a body signed with a different secret", async () => {
    const forged = await signPayload(BODY, "not-the-real-key");

    expect(await verifySignature(BODY, forged, SECRET)).toBe("invalid");
  });

  it("refuses a body edited after it was signed", async () => {
    const signature = await signPayload(BODY, SECRET);
    const tampered = BODY.replace("abc", "xyz");

    expect(await verifySignature(tampered, signature, SECRET)).toBe("invalid");
  });

  /*
    The 5-minute replay window (A8 point 4). A signature is only good for five
    minutes either side of its own timestamp, which is why
    scripts/replay-webhook.ts signs at the moment it runs rather than shipping a
    timestamp inside a fixture.
  */
  it("refuses a correct signature that is six minutes old", async () => {
    const stale = await signPayload(BODY, SECRET, Date.now() - 6 * 60_000);

    expect(await verifySignature(BODY, stale, SECRET)).toBe("invalid");
  });

  it("accepts a correct signature from a minute ago", async () => {
    const recent = await signPayload(BODY, SECRET, Date.now() - 60_000);

    expect(await verifySignature(BODY, recent, SECRET)).toBe("ok");
  });

  it.each([null, "", "nonsense", "v=abc,d=def", "d=deadbeef"])(
    "refuses %s as a signature header",
    async (signature) => {
      expect(await verifySignature(BODY, signature, SECRET)).toBe("invalid");
    },
  );

  /*
    An unconfigured deployment refuses everything, rather than comparing a blank
    secret against a blank header and calling it a match. Same rule as
    lib/tools/auth.ts:59 — an open endpoint that looks configured is worse than
    one that is plainly broken.
  */
  it.each(["", "   "])(
    "refuses everything when the secret is %s",
    async (secret) => {
      const signature = await signPayload(BODY, SECRET);

      expect(await verifySignature(BODY, signature, secret)).toBe(
        "unconfigured",
      );
    },
  );

  /*
    The same rule reached through the environment rather than the argument, and
    it has to stub both names — the secret falls back from
    RETELL_WEBHOOK_SECRET to RETELL_API_KEY, because they hold the same string
    (A8 point 3).

    Stubbed rather than left unset, so this asserts the same thing on a machine
    with a real .env.local as on one without. Passing `undefined` here instead
    would read whatever the developer happens to have configured, which is a
    test that changes its mind depending on who runs it.
  */
  it("refuses everything when the deployment has no key at all", async () => {
    vi.stubEnv("RETELL_WEBHOOK_SECRET", "");
    vi.stubEnv("RETELL_API_KEY", "");
    const signature = await signPayload(BODY, SECRET);

    expect(await verifySignature(BODY, signature)).toBe("unconfigured");
  });

  /*
    The async trap, as a compile error (A8 point 1).

    `Retell.verify()` is async. Written `if (!Retell.verify(...))` without an
    await, it negates a Promise — always falsy — and the handler accepts every
    forged payload while looking completely normal. Returning a string union
    instead of a boolean turns that mistake into a type error, because a Promise
    and the string "ok" have no overlap to compare.

    `@ts-expect-error` fails `npm run typecheck` if the error stops happening —
    so this line is what keeps the return type from drifting back to a boolean.
  */
  it("cannot be compared to a verdict without being awaited", () => {
    // @ts-expect-error — comparing the Promise, not the verdict.
    const trap = verifySignature(BODY, "v=1,d=2", SECRET) === "ok";

    expect(trap).toBe(false);
  });
});

describe("describeSignature", () => {
  /*
    Why the 401 happened, for the log line. `Retell.verify` answers only true or
    false, so without this a rejected delivery says "invalid signature" and
    leaves someone guessing between a wrong key, a clock six minutes out, and a
    proxy that dropped the header entirely.

    It says nothing about the digest. A log that echoes signature material is a
    log that leaks it.
  */
  it("says when the header never arrived", () => {
    expect(describeSignature(null)).toBe("no signature header");
  });

  it("says when the header is not the v=,d= shape", () => {
    expect(describeSignature("nonsense")).toBe("malformed signature header");
  });

  it("says when the timestamp is outside the replay window", () => {
    const sixMinutesAgo = Date.now() - 6 * 60_000;

    expect(describeSignature(`v=${sixMinutesAgo},d=deadbeef`)).toBe(
      "signature timestamp outside the 5-minute window",
    );
  });

  it("says the digest did not match when the timestamp was fine", () => {
    expect(describeSignature(`v=${Date.now()},d=deadbeef`)).toBe(
      "signature did not match",
    );
  });

  it("never repeats the digest", () => {
    const digest = "0123456789abcdef";

    expect(describeSignature(`v=${Date.now()},d=${digest}`)).not.toContain(
      digest,
    );
  });
});
