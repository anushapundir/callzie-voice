import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as inboundRoute } from "@/app/api/webhooks/retell/inbound/route";
import { db, schema } from "@/lib/db";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";
import { inboundFixture, type InboundFixture } from "@/lib/webhooks/fixtures";
import { signPayload } from "@/lib/webhooks/signature";

/*
  Issue #43's inbound webhook, driven through the real route handler by the real
  fixtures — no server, no socket, no Retell (SPEC.md §10, §3 rule 11).

  The thing under test is a decision, not a write: given a number that was
  dialled, does Callzie put the caller through, and to which Agent. Every branch
  below ends in one of two replies, and getting either wrong is either a
  stranger's call going unanswered or an account billed for calls it never agreed
  to take.
*/

const CLERK_ID = "user_test_inbound_route";
const SECRET = "inbound-route-test-secret";
const OUR_NUMBER = "+12025550190";
const CALLER = "+12025550142";

let seed: ToolTestSeed;

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: new Date("2026-09-14T04:30:00.000Z"),
  });

  await db
    .update(schema.businesses)
    .set({ inboundEnabled: true, emergencyLine: "+12025550111" })
    .where(eq(schema.businesses.id, seed.businessId));

  await db
    .insert(schema.phoneNumbers)
    .values({ businessId: seed.businessId, e164: OUR_NUMBER, purpose: "inbound" });

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

/** POST a fixture the way Retell would — signed, over the exact bytes. */
async function deliver(
  fixture: InboundFixture,
  {
    toNumber = OUR_NUMBER,
    signature,
  }: { toNumber?: string; signature?: string | null } = {},
) {
  const body = inboundFixture(fixture, { toNumber, fromNumber: CALLER });

  const headers = new Headers({ "content-type": "application/json" });
  const value =
    signature === undefined ? await signPayload(body, SECRET) : signature;
  if (value !== null) headers.set("x-retell-signature", value);

  return inboundRoute(
    new Request("https://callzie.example/api/webhooks/retell/inbound", {
      method: "POST",
      headers,
      body,
    }),
  );
}

beforeEach(() => {
  process.env.RETELL_WEBHOOK_SECRET = SECRET;
});

describe("the inbound webhook", () => {
  it("puts a caller through to this Business's inbound Agent", async () => {
    const response = await deliver("call-inbound");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.call_inbound.override_agent_id).toBe("agent_inbound_salon");
    // The one field the Tools cannot work without. Everything inbound resolves
    // its tenant from this, never from an argument the model wrote.
    expect(body.call_inbound.metadata.business_id).toBe(seed.businessId);
  });

  it("tells Maya what the Business offers before she speaks", async () => {
    const body = await (await deliver("call-inbound")).json();

    expect(body.call_inbound.dynamic_variables.services_list).toBe(
      "Haircut (60 minutes)",
    );
    expect(body.call_inbound.dynamic_variables.emergency_line).toBe(
      "+12025550111",
    );
  });

  it("hands Retell only strings", async () => {
    // A non-string variable renders literally, so a plumbing bug is a sentence
    // the caller hears (docs/verification.md A5).
    const body = await (await deliver("call-inbound")).json();

    for (const value of Object.values(
      body.call_inbound.dynamic_variables as Record<string, unknown>,
    )) {
      expect(typeof value).toBe("string");
    }
  });

  describe("what it declines", () => {
    it("declines a number no Business owns", async () => {
      const body = await (
        await deliver("call-inbound", { toNumber: "+12025550999" })
      ).json();

      expect(body).toEqual({ call_inbound: { reject: true } });
    });

    it("declines when the account has not switched inbound on", async () => {
      await db
        .update(schema.businesses)
        .set({ inboundEnabled: false })
        .where(eq(schema.businesses.id, seed.businessId));

      const body = await (await deliver("call-inbound")).json();

      expect(body.call_inbound.reject).toBe(true);
    });

    it("declines a withheld caller ID", async () => {
      const body = await (await deliver("call-inbound-anonymous")).json();

      expect(body.call_inbound.reject).toBe(true);
    });

    it("declines a text message on the same URL", async () => {
      /*
        Retell's inbound webhook covers SMS. Answering one with an agent id is
        Callzie claiming to have handled something it has not — and the reply is
        a decline rather than a 400, because a 400 would be retried three times.
      */
      const response = await deliver("sms-inbound");
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.call_inbound.reject).toBe(true);
    });

    it("declines rather than throwing when no Agent is provisioned", async () => {
      /*
        A database `npm run create-agents` has never been run against. Inside
        Retell's ten-second window an exception is silence on the line, so the
        route turns it into a decline.
      */
      await db
        .delete(schema.retellAgents)
        .where(eq(schema.retellAgents.agentId, "agent_inbound_salon"));

      const response = await deliver("call-inbound");

      expect(response.status).toBe(200);
      expect((await response.json()).call_inbound.reject).toBe(true);
    });

    it("never carries an agent id alongside a rejection", async () => {
      // `reject` wins over agent selection, so a stray agent id would be dead
      // weight that reads as though it might do something.
      const body = await (
        await deliver("call-inbound", { toNumber: "+12025550999" })
      ).json();

      expect(body.call_inbound).not.toHaveProperty("override_agent_id");
      expect(body.call_inbound).not.toHaveProperty("dynamic_variables");
    });
  });

  describe("the signature gate", () => {
    /*
      ⚠️ This endpoint assumes the same `X-Retell-Signature` scheme the call
      webhook uses, which Retell's inbound docs do not confirm — see the route's
      own comment and docs/verification.md. These tests pin the behaviour
      Callzie implements; they cannot pin what Retell sends.
    */
    it("refuses a body with no signature", async () => {
      const response = await deliver("call-inbound", { signature: null });

      expect(response.status).toBe(401);
    });

    it("refuses a signature from the wrong key", async () => {
      const body = inboundFixture("call-inbound", {
        toNumber: OUR_NUMBER,
        fromNumber: CALLER,
      });
      const forged = await signPayload(body, "not-the-right-secret");

      const response = await deliver("call-inbound", { signature: forged });

      expect(response.status).toBe(401);
    });

    it("refuses a valid signature over different bytes", async () => {
      // The signature is over exact bytes. A body swapped after signing must
      // not verify.
      const other = inboundFixture("call-inbound", {
        toNumber: "+12025550999",
        fromNumber: CALLER,
      });
      const mismatched = await signPayload(other, SECRET);

      const response = await deliver("call-inbound", { signature: mismatched });

      expect(response.status).toBe(401);
    });

    it("refuses everything when no secret is configured", async () => {
      /*
        A blank secret matching a blank header would be an open endpoint that
        looks configured — and this one reveals which Business owns which phone
        number, so it would be enumerable by anyone with a list of numbers.
      */
      delete process.env.RETELL_WEBHOOK_SECRET;
      const apiKey = process.env.RETELL_API_KEY;
      delete process.env.RETELL_API_KEY;

      try {
        const response = await deliver("call-inbound", { signature: "v=1,d=00" });
        expect(response.status).toBe(401);
      } finally {
        process.env.RETELL_WEBHOOK_SECRET = SECRET;
        if (apiKey !== undefined) process.env.RETELL_API_KEY = apiKey;
      }
    });
  });

  it("writes nothing — the call_started delivery does that", async () => {
    /*
      There is no `retell_call_id` yet at `call_inbound` time, so there is no
      row to write. `business_id` rides through in metadata and the ordinary
      `call_started` handler — already idempotent, already verified — creates it.
    */
    await deliver("call-inbound");

    const calls = await db
      .select()
      .from(schema.calls)
      .where(eq(schema.calls.direction, "inbound"));

    expect(calls).toHaveLength(0);
  });
});
