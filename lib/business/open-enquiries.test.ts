import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import { listOpenEnquiries, resolveEnquiry } from "@/lib/business/open-enquiries";
import type { EnquiryKind } from "@/lib/db/schema";
import {
  cleanupToolTest,
  seedInboundCall,
  seedToolTest,
  type ToolTestSeed,
} from "@/lib/tools/testing";

/*
  The inbound half of the Needs Attention surface (issue #43).

  Every test here is about one of two properties: an open Enquiry must not be
  possible to lose, and one account must never see or clear another's.
*/

const CLERK_ID = "user_test_open_enquiries";
const OTHER_CLERK_ID = "user_test_open_enquiries_other";

let seed: ToolTestSeed;
let callCounter = 0;

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  await cleanupToolTest(OTHER_CLERK_ID);
  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: new Date("2026-09-14T04:30:00.000Z"),
  });
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
  await cleanupToolTest(OTHER_CLERK_ID);
});

async function addEnquiry(
  businessId: string,
  kind: EnquiryKind,
  resolved: boolean,
  topic = "Wants a call back.",
): Promise<string> {
  callCounter += 1;
  const call = await seedInboundCall({
    businessId,
    retellCallId: `call_enquiry_${callCounter}_${Date.now()}`,
  });

  const [row] = await db
    .insert(schema.enquiries)
    .values({
      callId: call.callId,
      kind,
      topic,
      callerName: "Rahul Verma",
      callerPhoneE164: "+12025550142",
      resolved,
    })
    .returning({ id: schema.enquiries.id });

  return row.id;
}

describe("listOpenEnquiries", () => {
  it("lists what a human still has to deal with", async () => {
    await addEnquiry(seed.businessId, "callback", false);
    await addEnquiry(seed.businessId, "complaint", false);

    const rows = await listOpenEnquiries(seed.businessId);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.kind).sort()).toEqual(["callback", "complaint"]);
  });

  it("leaves out anything already dealt with", async () => {
    await addEnquiry(seed.businessId, "question", true);

    expect(await listOpenEnquiries(seed.businessId)).toHaveLength(0);
  });

  it("never shows another account's Enquiry", async () => {
    const other = await seedToolTest({
      clerkId: OTHER_CLERK_ID,
      appointmentStartsAt: new Date("2026-09-15T04:30:00.000Z"),
    });
    await addEnquiry(other.businessId, "complaint", false);

    expect(await listOpenEnquiries(seed.businessId)).toHaveLength(0);
  });

  it("carries the number to ring back on", async () => {
    // The whole point of a callback Enquiry. A row without it is a person
    // nobody can reach.
    await addEnquiry(seed.businessId, "callback", false);

    const [row] = await listOpenEnquiries(seed.businessId);

    expect(row.callerPhoneE164).toBe("+12025550142");
    expect(row.topic).toBe("Wants a call back.");
  });

  it("links to the Call, so the transcript is one click away", async () => {
    await addEnquiry(seed.businessId, "complaint", false);

    const [row] = await listOpenEnquiries(seed.businessId);

    expect(row.callId).toBeTruthy();
  });
});

describe("resolveEnquiry", () => {
  it("clears one, and it stops being listed", async () => {
    const id = await addEnquiry(seed.businessId, "callback", false);

    expect(await resolveEnquiry(seed.businessId, id)).toBe(true);
    expect(await listOpenEnquiries(seed.businessId)).toHaveLength(0);
  });

  it("refuses to clear another account's Enquiry", async () => {
    /*
      The guard is inside the UPDATE's WHERE clause, not in a branch above it.
      A Server Action is a POST anybody can send, so this has to match zero rows
      rather than be caught by an `if` somebody could reorder.
    */
    const other = await seedToolTest({
      clerkId: OTHER_CLERK_ID,
      appointmentStartsAt: new Date("2026-09-15T04:30:00.000Z"),
    });
    const theirs = await addEnquiry(other.businessId, "complaint", false);

    expect(await resolveEnquiry(seed.businessId, theirs)).toBe(false);
    // Still open, on their side.
    expect(await listOpenEnquiries(other.businessId)).toHaveLength(1);
  });

  it("says no when the id is nobody's", async () => {
    const missing = "11111111-2222-3333-4444-555555555555";

    expect(await resolveEnquiry(seed.businessId, missing)).toBe(false);
  });

  it("destroys nothing — the Enquiry is still there to read", async () => {
    // Clearing stops it asking; it does not delete the record. The Call detail
    // screen still shows the topic, the caller and the transcript.
    const id = await addEnquiry(seed.businessId, "complaint", false);
    await resolveEnquiry(seed.businessId, id);

    const row = await db.query.enquiries.findFirst({
      where: eq(schema.enquiries.id, id),
    });

    expect(row).toBeDefined();
    expect(row?.resolved).toBe(true);
    expect(row?.topic).toBe("Wants a call back.");
  });
});
