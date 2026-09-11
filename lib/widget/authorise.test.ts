import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db, schema } from "@/lib/db";
import {
  authoriseWidget,
  newWidgetKey,
  originAllowed,
} from "@/lib/widget/authorise";
import { startWidgetCall } from "@/lib/widget/start";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

/*
  The fence around the one route in Callzie reachable without a session
  (issue #45).

  Every test here is about somebody spending an account's money without that
  account being present to approve it. The key is public by construction — it
  ships in HTML — so almost all of the weight is on the origin allowlist and the
  two caps.
*/

const CLERK_ID = "user_test_widget";
const KEY = "czw_test_key_for_the_widget_suite";
const SITE = "https://nairdental.example";
const NOW = new Date("2026-09-07T16:00:00.000Z");

let seed: ToolTestSeed;

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: new Date("2026-09-14T04:30:00.000Z"),
  });

  await db
    .update(schema.businesses)
    .set({
      inboundEnabled: true,
      emergencyLine: "+12025550111",
      widgetKey: KEY,
      widgetOrigins: [SITE],
    })
    .where(eq(schema.businesses.id, seed.businessId));

  await db.insert(schema.retellAgents).values({
    businessType: "salon",
    direction: "inbound",
    llmId: "llm_inbound_salon",
    agentId: "agent_inbound_salon",
  });
});

afterEach(async () => {
  await db
    .delete(schema.retellAgents)
    .where(eq(schema.retellAgents.agentId, "agent_inbound_salon"));
  await cleanupToolTest(CLERK_ID);
});

function authorise(overrides: { key?: string; origin?: string | null } = {}) {
  return authoriseWidget({
    key: overrides.key ?? KEY,
    origin: overrides.origin === undefined ? SITE : overrides.origin,
    now: NOW,
  });
}

describe("newWidgetKey", () => {
  it("is unguessable and recognisable", () => {
    const key = newWidgetKey();

    expect(key.startsWith("czw_")).toBe(true);
    // 24 random bytes in base64url is 32 characters.
    expect(key.length).toBeGreaterThan(30);
    expect(newWidgetKey()).not.toBe(key);
  });
});

describe("originAllowed", () => {
  it("accepts an exact origin", () => {
    expect(originAllowed(SITE, [SITE])).toBe(true);
  });

  it("ignores a trailing slash and casing", () => {
    // An owner who typed a trailing slash must not get a widget that silently
    // never opens.
    expect(originAllowed("https://NairDental.example/", [SITE])).toBe(true);
  });

  it("refuses a suffix match", () => {
    /*
      The classic way this check is written wrong. `endsWith(".example.com")`
      is defeated by `evil-example.com`, so the comparison is on the whole
      serialised origin and nothing else.
    */
    expect(originAllowed("https://evil-nairdental.example", [SITE])).toBe(false);
  });

  it("refuses a subdomain that was not listed", () => {
    // No wildcards. One compromised subdomain must not spend the account's
    // whole allowance.
    expect(originAllowed("https://blog.nairdental.example", [SITE])).toBe(false);
  });

  it("refuses a different scheme", () => {
    // http and https are different origins, and one of them is not encrypted.
    expect(originAllowed("http://nairdental.example", [SITE])).toBe(false);
  });

  it("refuses a different port", () => {
    expect(originAllowed("https://nairdental.example:8443", [SITE])).toBe(false);
  });

  it("refuses a missing Origin header", () => {
    // Browsers send it on the cross-origin POST the widget makes, so an absent
    // one is not the thing this route exists for.
    expect(originAllowed(null, [SITE])).toBe(false);
  });

  it("refuses everything when nothing is listed", () => {
    // An empty allowlist means the widget is off, not that anything goes.
    expect(originAllowed(SITE, [])).toBe(false);
  });

  it("refuses a value that is not a URL", () => {
    expect(originAllowed("nairdental.example", [SITE])).toBe(false);
    expect(originAllowed("null", [SITE])).toBe(false);
  });
});

describe("authoriseWidget", () => {
  it("admits a listed origin with a real key", async () => {
    const result = await authorise();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.businessId).toBe(seed.businessId);
  });

  it("refuses a key nobody owns", async () => {
    expect(await authorise({ key: "czw_not_a_real_key" })).toEqual({
      ok: false,
      reason: "unknown_key",
    });
  });

  it("refuses a real key from the wrong site", async () => {
    // The key is public — it ships in HTML. This is the check that makes a
    // stolen one useless.
    expect(await authorise({ origin: "https://somewhere-else.example" })).toEqual({
      ok: false,
      reason: "origin_not_allowed",
    });
  });

  it("refuses when the account is not answering calls", async () => {
    await db
      .update(schema.businesses)
      .set({ inboundEnabled: false })
      .where(eq(schema.businesses.id, seed.businessId));

    expect(await authorise()).toEqual({ ok: false, reason: "inbound_disabled" });
  });

  it("refuses when there is no emergency number", async () => {
    /*
      SPEC.md §14 rule 10 does not stop applying because the caller arrived
      through a browser. A widget visitor can describe an emergency exactly as a
      phone caller can.
    */
    await db
      .update(schema.businesses)
      .set({ emergencyLine: null })
      .where(eq(schema.businesses.id, seed.businessId));

    expect(await authorise()).toEqual({ ok: false, reason: "inbound_disabled" });
  });

  it("refuses once the account's inbound allowance is spent", async () => {
    await db
      .update(schema.businesses)
      .set({ inboundQuota: 5, inboundCallsUsed: 5 })
      .where(eq(schema.businesses.id, seed.businessId));

    expect(await authorise()).toEqual({ ok: false, reason: "quota_exhausted" });
  });

  describe("the daily cap", () => {
    async function addWidgetCalls(n: number, at: Date) {
      for (let i = 0; i < n; i++) {
        await db.insert(schema.calls).values({
          businessId: seed.businessId,
          direction: "inbound",
          callType: "web",
          status: "completed",
          createdAt: at,
        });
      }
    }

    it("holds when a key leaks to somebody on the allowlist", async () => {
      // The ceiling that survives both other checks being defeated — a
      // compromised page on the business's own site, say.
      await db
        .update(schema.businesses)
        .set({ widgetDailyCap: 3 })
        .where(eq(schema.businesses.id, seed.businessId));

      await addWidgetCalls(3, new Date(NOW.getTime() - 60_000));

      expect(await authorise()).toEqual({
        ok: false,
        reason: "daily_cap_reached",
      });
    });

    it("forgets calls older than a day", async () => {
      await db
        .update(schema.businesses)
        .set({ widgetDailyCap: 3 })
        .where(eq(schema.businesses.id, seed.businessId));

      await addWidgetCalls(3, new Date(NOW.getTime() - 25 * 60 * 60_000));

      expect((await authorise()).ok).toBe(true);
    });

    it("does not count phone calls against the website's cap", async () => {
      /*
        The pair (inbound, web) is what identifies a widget Call. Counting
        `inbound` alone would let a busy phone afternoon close the website.
      */
      await db
        .update(schema.businesses)
        .set({ widgetDailyCap: 1 })
        .where(eq(schema.businesses.id, seed.businessId));

      await db.insert(schema.calls).values({
        businessId: seed.businessId,
        direction: "inbound",
        callType: "phone",
        fromNumber: "+12025550142",
        status: "completed",
        createdAt: new Date(NOW.getTime() - 60_000),
      });

      expect((await authorise()).ok).toBe(true);
    });
  });
});

describe("startWidgetCall", () => {
  function creator() {
    return vi.fn(async () => ({
      call_id: "call_widget_abc",
      access_token: "tok_abc123",
    }));
  }

  it("returns a token and records an inbound web Call", async () => {
    const createCall = creator();

    const result = await startWidgetCall({
      key: KEY,
      origin: SITE,
      createCall,
      now: NOW,
    });

    expect(result).toEqual({ ok: true, accessToken: "tok_abc123" });

    const [call] = await db
      .select()
      .from(schema.calls)
      .where(eq(schema.calls.retellCallId, "call_widget_abc"));

    expect(call.direction).toBe("inbound");
    expect(call.callType).toBe("web");
    // Null, never a placeholder — a fake number here would be matched by
    // `lookup_appointment` and show one visitor another's Appointment.
    expect(call.fromNumber).toBeNull();
  });

  it("sends the tenant in metadata, so the Tools can resolve it", async () => {
    const createCall = creator();

    await startWidgetCall({ key: KEY, origin: SITE, createCall, now: NOW });

    expect(createCall).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_id: "agent_inbound_salon",
        metadata: expect.objectContaining({ business_id: seed.businessId }),
      }),
    );
  });

  it("tells Maya the same things a phone caller would hear", async () => {
    const createCall = creator();

    await startWidgetCall({ key: KEY, origin: SITE, createCall, now: NOW });

    expect(createCall).toHaveBeenCalledWith(
      expect.objectContaining({
        retell_llm_dynamic_variables: expect.objectContaining({
          services_list: "Haircut (60 minutes)",
          emergency_line: "+12025550111",
        }),
      }),
    );
  });

  it("spends the allowance only once Retell has agreed", async () => {
    await startWidgetCall({ key: KEY, origin: SITE, createCall: creator(), now: NOW });

    const business = await db.query.businesses.findFirst({
      where: eq(schema.businesses.id, seed.businessId),
    });

    expect(business?.inboundCallsUsed).toBe(1);
  });

  it("contacts nobody when the request is not authorised", async () => {
    const createCall = creator();

    const result = await startWidgetCall({
      key: KEY,
      origin: "https://somewhere-else.example",
      createCall,
      now: NOW,
    });

    expect(result).toEqual({ ok: false, reason: "origin_not_allowed" });
    expect(createCall).not.toHaveBeenCalled();
  });

  it("marks the Call failed when Retell refuses it", async () => {
    /*
      The compensating write. Without it the row sits `queued` forever —
      counting against the daily cap and showing on the dashboard as a Call that
      never happened.
    */
    const createCall = vi.fn(async () => {
      throw new Error("retell is down");
    });

    const result = await startWidgetCall({
      key: KEY,
      origin: SITE,
      createCall,
      now: NOW,
    });

    expect(result).toEqual({ ok: false, reason: "call_failed" });

    const [call] = await db
      .select()
      .from(schema.calls)
      .where(eq(schema.calls.businessId, seed.businessId));

    expect(call.status).toBe("failed");
    expect(call.disconnectReason).toBe("widget_create_failed");
  });

  it("does not spend the allowance on a Call that never started", async () => {
    const createCall = vi.fn(async () => {
      throw new Error("retell is down");
    });

    await startWidgetCall({ key: KEY, origin: SITE, createCall, now: NOW });

    const business = await db.query.businesses.findFirst({
      where: eq(schema.businesses.id, seed.businessId),
    });

    expect(business?.inboundCallsUsed).toBe(0);
  });
});
