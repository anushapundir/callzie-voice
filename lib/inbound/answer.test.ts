import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import { answerInboundCall } from "@/lib/inbound/answer";
import { MAX_CALLS_PER_NUMBER } from "@/lib/inbound/decide";
import { cleanupToolTest, seedToolTest } from "@/lib/tools/testing";

/*
  The whole inbound webhook path, against a real database — the number lookup,
  the guards, and the variables Maya is handed before she speaks.

  Mon 2026-09-07, Asia/Kolkata, hours 09:00-17:00 weekdays:
    16:00Z = 21:30 local. Closed, which is the call this feature exists for.
*/

const CLERK_ID = "user_test_inbound_answer";
const EVENING = new Date("2026-09-07T16:00:00.000Z");
const OUR_NUMBER = "+12025550190";
const CALLER = "+12025550142";

let businessId: string;

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  const seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: new Date("2026-09-14T04:30:00.000Z"),
  });
  businessId = seed.businessId;

  await db
    .update(schema.businesses)
    .set({ inboundEnabled: true, emergencyLine: "+12025550111" })
    .where(eq(schema.businesses.id, businessId));

  await db
    .insert(schema.phoneNumbers)
    .values({ businessId, e164: OUR_NUMBER, purpose: "inbound" });

  // The inbound Agent the reply must name. `seedToolTest` builds a salon.
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

function answer(overrides: { toNumber?: string; fromNumber?: string | null } = {}) {
  return answerInboundCall({
    toNumber: overrides.toNumber ?? OUR_NUMBER,
    fromNumber: overrides.fromNumber === undefined ? CALLER : overrides.fromNumber,
    now: EVENING,
  });
}

async function addInboundCall(fromNumber: string, createdAt: Date) {
  await db.insert(schema.calls).values({
    businessId,
    direction: "inbound",
    fromNumber,
    callType: "phone",
    status: "completed",
    createdAt,
  });
}

describe("answerInboundCall", () => {
  it("admits a call to a configured number and names the inbound Agent", async () => {
    const result = await answer();

    expect(result.admit).toBe(true);
    if (!result.admit) return;

    expect(result.businessId).toBe(businessId);
    // The inbound Agent, not the outbound one. Getting this wrong reaches a
    // caller with Maya asking about an appointment they never made.
    expect(result.agentId).toBe("agent_inbound_salon");
  });

  it("hands Maya the Business's real Services", async () => {
    const result = await answer();
    if (!result.admit) throw new Error("expected an admission");

    /*
      This is the whole of what Maya knows about what the business does. There
      is no knowledge base behind her, which is the point — every service she
      can name is a row somebody typed into Settings, so she cannot invent one.
    */
    expect(result.dynamicVariables.services_list).toBe("Haircut (60 minutes)");
  });

  it("tells Maya the business is closed, and when it opens", async () => {
    const result = await answer();
    if (!result.admit) throw new Error("expected an admission");

    expect(result.dynamicVariables.is_open_now).toBe("no");
    expect(result.dynamicVariables.next_open).toBe("Tuesday at 9:00am");
    expect(result.dynamicVariables.local_time).toBe("9:30pm");
    expect(result.dynamicVariables.hours_today).toBe("9:00am to 5:00pm");
  });

  it("carries the emergency number, so rule 10 is possible", async () => {
    const result = await answer();
    if (!result.admit) throw new Error("expected an admission");

    expect(result.dynamicVariables.emergency_line).toBe("+12025550111");
  });

  it("hands Retell only strings", async () => {
    /*
      Retell renders a non-string variable literally, so a plumbing bug is a
      sentence the caller hears — "curly-curly-business-name" — rather than an
      error anybody sees (docs/verification.md A5).
    */
    const result = await answer();
    if (!result.admit) throw new Error("expected an admission");

    for (const [key, value] of Object.entries(result.dynamicVariables)) {
      expect(typeof value, `${key} must be a string`).toBe("string");
    }
  });

  it("refuses a number no Business owns", async () => {
    expect(await answer({ toNumber: "+12025550999" })).toEqual({
      admit: false,
      reason: "unknown_number",
    });
  });

  it("refuses an account that has not switched inbound on", async () => {
    await db
      .update(schema.businesses)
      .set({ inboundEnabled: false })
      .where(eq(schema.businesses.id, businessId));

    expect(await answer()).toEqual({ admit: false, reason: "inbound_disabled" });
  });

  it("refuses once the inbound allowance is spent", async () => {
    await db
      .update(schema.businesses)
      .set({ inboundQuota: 3, inboundCallsUsed: 3 })
      .where(eq(schema.businesses.id, businessId));

    expect(await answer()).toEqual({ admit: false, reason: "quota_exhausted" });
  });

  it("does not spend the inbound allowance on outbound Calls", async () => {
    // An account chooses when to place a Call and does not choose when its
    // phone rings. One counter for both would let a busy morning silence it.
    await db
      .update(schema.businesses)
      .set({ callQuota: 5, callsUsed: 5, inboundQuota: 20, inboundCallsUsed: 0 })
      .where(eq(schema.businesses.id, businessId));

    expect((await answer()).admit).toBe(true);
  });

  it("refuses a withheld caller ID", async () => {
    expect(await answer({ fromNumber: null })).toEqual({
      admit: false,
      reason: "anonymous_caller",
    });
  });

  describe("the rate limit", () => {
    it("refuses a number that has called too many times in the hour", async () => {
      for (let i = 0; i < MAX_CALLS_PER_NUMBER; i++) {
        await addInboundCall(CALLER, new Date(EVENING.getTime() - 60_000));
      }

      expect(await answer()).toEqual({
        admit: false,
        reason: "too_many_recent_calls",
      });
    });

    it("ignores calls older than the window", async () => {
      for (let i = 0; i < MAX_CALLS_PER_NUMBER; i++) {
        // Just over an hour ago.
        await addInboundCall(CALLER, new Date(EVENING.getTime() - 61 * 60_000));
      }

      expect((await answer()).admit).toBe(true);
    });

    it("counts only this caller, not everyone who rang", async () => {
      for (let i = 0; i < MAX_CALLS_PER_NUMBER; i++) {
        await addInboundCall("+12025550143", new Date(EVENING.getTime() - 60_000));
      }

      expect((await answer()).admit).toBe(true);
    });

    it("does not count outbound Calls to the same number", async () => {
      /*
        `fromNumber` is null on outbound rows, so this is really a guard against
        somebody later widening the query to match a destination. A business
        that rang a customer five times must not lose the ability to take their
        call back.
      */
      for (let i = 0; i < MAX_CALLS_PER_NUMBER; i++) {
        await db.insert(schema.calls).values({
          businessId,
          direction: "outbound",
          fromNumber: CALLER,
          callType: "phone",
          status: "completed",
          createdAt: new Date(EVENING.getTime() - 60_000),
          appointmentId: (
            await db.query.appointments.findFirst({
              where: eq(schema.appointments.businessId, businessId),
            })
          )?.id,
        });
      }

      expect((await answer()).admit).toBe(true);
    });
  });

  it("refuses rather than throwing when no inbound Agent is provisioned", async () => {
    /*
      A database the create-agents script has never been run against. Inside
      Retell's ten-second window an exception is silence on the line, so the
      route turns it into a decline — this test proves the throw happens where
      that catch can see it.
    */
    await db
      .delete(schema.retellAgents)
      .where(eq(schema.retellAgents.agentId, "agent_inbound_salon"));

    await expect(answer()).rejects.toThrow(/No inbound Retell Agent/);
  });
});
