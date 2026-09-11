import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseToolRequest, resolveToolContext } from "@/lib/tools/request";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

const CLERK_ID = "user_test_tools_request";
const APPOINTMENT_STARTS_AT = new Date("2026-08-17T03:30:00.000Z");

let seed: ToolTestSeed;

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: APPOINTMENT_STARTS_AT,
  });
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
});

describe("parseToolRequest", () => {
  it("reads the envelope docs/verification.md A12 records", () => {
    expect(
      parseToolRequest({
        name: "book_slot",
        call: { call_id: "call_abc", transcript: "Agent: hello" },
        args: { slot_start: "2026-08-20T08:30:00.000Z" },
      }),
    ).toEqual({
      name: "book_slot",
      callId: "call_abc",
      args: { slot_start: "2026-08-20T08:30:00.000Z" },
    });
  });

  it("treats a missing args object as no arguments", () => {
    // confirm_appointment and cancel_appointment declare an empty schema
    // (lib/retell/tools.ts), and an empty schema may arrive as no key at all.
    expect(
      parseToolRequest({ name: "confirm_appointment", call: { call_id: "call_abc" } }),
    ).toEqual({ name: "confirm_appointment", callId: "call_abc", args: {} });
  });

  it.each([
    ["a string", "nope"],
    ["null", null],
    ["an array", []],
    ["no name", { call: { call_id: "call_abc" }, args: {} }],
    ["a blank name", { name: "", call: { call_id: "call_abc" }, args: {} }],
    ["no call", { name: "book_slot", args: {} }],
    ["no call_id", { name: "book_slot", call: {}, args: {} }],
    ["a numeric call_id", { name: "book_slot", call: { call_id: 7 }, args: {} }],
    ["a blank call_id", { name: "book_slot", call: { call_id: "" }, args: {} }],
    ["an array for args", { name: "book_slot", call: { call_id: "c" }, args: [] }],
  ])("refuses a body that is %s", (_label, body) => {
    expect(parseToolRequest(body)).toBeNull();
  });
});

describe("resolveToolContext", () => {
  it("resolves the Call to its Appointment, Business and Service", async () => {
    const context = await resolveToolContext(seed.retellCallId);

    expect(context).not.toBeNull();
    expect(context!.callId).toBe(seed.callId);
    expect(context!.businessId).toBe(seed.businessId);
    expect(context!.serviceId).toBe(seed.serviceId);
    expect(context!.timezone).toBe("Asia/Kolkata");
    expect(context!.durationMinutes).toBe(60);
    expect(context!.appointment.id).toBe(seed.appointmentId);
    expect(context!.appointment.startsAt).toEqual(APPOINTMENT_STARTS_AT);
  });

  it("returns null for a call_id nothing knows about", async () => {
    // A model cannot invent its way into a row: identity comes from `call`, and
    // an unknown one resolves to nothing rather than to a default.
    expect(await resolveToolContext("call_does_not_exist")).toBeNull();
  });

  it("returns null for a blank call_id", async () => {
    expect(await resolveToolContext("")).toBeNull();
  });
});
