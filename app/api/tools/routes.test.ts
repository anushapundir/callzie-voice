import { readFileSync } from "node:fs";

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as bookSlotRoute } from "@/app/api/tools/book-slot/route";
import { POST as cancelRoute } from "@/app/api/tools/cancel-appointment/route";
import { POST as checkRoute } from "@/app/api/tools/check-availability/route";
import { POST as confirmRoute } from "@/app/api/tools/confirm-appointment/route";
import { db, schema } from "@/lib/db";
import { TOOL_PATHS } from "@/lib/retell/tools";
import { COMMITTED, NOT_COMMITTED } from "@/lib/tools/say";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

/*
  The acceptance criteria, driven through the real route handlers by a fixture
  shaped exactly as docs/verification.md A12 records Retell's body.

  No server is started and no socket is opened. Next 16 route handlers are plain
  functions over the Web Request/Response types, so this is the real handler on
  the real path rather than a stand-in — and the whole file costs nothing to run
  (SPEC.md §10).
*/

/*
  `after()` schedules work to run once the response is sent. The Tool routes use
  it for ADR-0004's Google Calendar push, and calling it outside a request scope
  throws — so it is collected here instead, the same way
  app/api/webhooks/retell/route.test.ts does.

  These tests deliberately never flush the collected callbacks. What they are
  about is what Maya is told and what Postgres holds, and the whole point of the
  push being deferred is that neither depends on it. `lib/google/sync.test.ts`
  covers what the callback does; this file proves it cannot affect the answer.
*/
const { afterCallbacks } = vi.hoisted(() => ({
  afterCallbacks: [] as (() => unknown)[],
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (callback: () => unknown) => {
    afterCallbacks.push(callback);
  },
}));

const CLERK_ID = "user_test_tools_routes";
const SECRET = "routes-test-internal-secret";

const APPOINTMENT_STARTS_AT = new Date("2026-08-17T03:30:00.000Z");

let seed: ToolTestSeed;

type Fixture =
  | "check-availability"
  | "book-slot"
  | "confirm-appointment"
  | "cancel-appointment";

function fixture(name: Fixture): Record<string, unknown> {
  return JSON.parse(readFileSync(`./fixtures/retell/tools/${name}.json`, "utf8"));
}

/** The Request Retell would send, with the placeholders filled in. */
function toolRequest(
  name: Fixture,
  options: { slotStart?: string; headers?: Record<string, string> } = {},
): Request {
  const body = fixture(name);
  (body.call as { call_id: string }).call_id = seed.retellCallId;
  if (options.slotStart !== undefined) {
    (body.args as { slot_start: string }).slot_start = options.slotStart;
  }

  const path = TOOL_PATHS[body.name as keyof typeof TOOL_PATHS];
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? { Authorization: `Bearer ${SECRET}` }),
    },
    body: JSON.stringify(body),
  });
}

/** A hand-built request, for the cases a fixture cannot express. */
function rawRequest(body: string): Request {
  return new Request("http://localhost/api/tools/check-availability", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${SECRET}` },
    body,
  });
}

/** Park a competing Appointment on a Slot, as a concurrent Call would. */
async function occupy(slotStart: string) {
  await db.insert(schema.appointments).values({
    businessId: seed.businessId,
    serviceId: seed.serviceId,
    name: "Faster Caller",
    phoneE164: "+919876500002",
    startsAt: new Date(slotStart),
    // seedToolTest's Service is 60 minutes.
    endsAt: new Date(new Date(slotStart).getTime() + 60 * 60_000),
    status: "confirmed",
  });
}

type OfferedRow = { slot_start: string; time: string };

beforeEach(async () => {
  vi.stubEnv("INTERNAL_SECRET", SECRET);
  // Deferred work from a previous test must not leak into this one's count.
  afterCallbacks.length = 0;
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: APPOINTMENT_STARTS_AT,
  });
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
  vi.unstubAllEnvs();
});

const ROUTES = [
  ["check_availability", checkRoute, "check-availability"],
  ["book_slot", bookSlotRoute, "book-slot"],
  ["confirm_appointment", confirmRoute, "confirm-appointment"],
  ["cancel_appointment", cancelRoute, "cancel-appointment"],
] as const;

describe("the Google Calendar push (ADR-0004, issue #20)", () => {
  it("defers a push after a booking, rather than making Maya wait", async () => {
    /*
      The placement is the point. `book_slot` moves an Appointment, so the
      calendar has to be told — but Maya is mid-sentence, and a Google round
      trip on this path is dead air the customer hears. The work is collected
      by `after()`, which runs it once the response has gone.
    */
    const offered = await (await checkRoute(toolRequest("check-availability"))).json();
    await bookSlotRoute(
      toolRequest("book-slot", { slotStart: offered.slots[0].start }),
    );

    expect(afterCallbacks).toHaveLength(1);
  });

  it("defers a push after a cancellation", async () => {
    // A cancelled Appointment frees its Slot, so its event must go — leaving it
    // would hold time on the owner's calendar for somebody not coming.
    await cancelRoute(toolRequest("cancel-appointment"));

    expect(afterCallbacks).toHaveLength(1);
  });

  it("pushes nothing for the two Tools that change no time", async () => {
    /*
      `check_availability` only offers times and `confirm_appointment` changes a
      status without touching `starts_at`. Pushing for either would be a wasted
      round trip on every offer Maya makes, and she makes several per Call.
    */
    await checkRoute(toolRequest("check-availability"));
    await confirmRoute(toolRequest("confirm-appointment"));

    expect(afterCallbacks).toHaveLength(0);
  });
});

describe("every Tool endpoint is reachable only with the internal secret", () => {
  it.each(ROUTES)("%s refuses a request with no credential", async (_name, route, file) => {
    const response = await route(toolRequest(file, { headers: {} }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it.each(ROUTES)("%s refuses the wrong secret", async (_name, route, file) => {
    const response = await route(
      toolRequest(file, { headers: { Authorization: "Bearer wrong" } }),
    );
    expect(response.status).toBe(401);
  });

  it.each(ROUTES)("%s accepts X-Callzie-Secret as well", async (_name, route, file) => {
    // docs/verification.md A12: whether Retell forwards Authorization unmodified
    // is unverified, and this is the named fallback.
    const response = await route(
      toolRequest(file, { headers: { "X-Callzie-Secret": SECRET } }),
    );
    expect(response.status).toBe(200);
  });

  it("records nothing for a rejected request", async () => {
    await checkRoute(toolRequest("check-availability", { headers: {} }));
    expect(await db.select().from(schema.toolInvocations)).toHaveLength(0);
  });
});

describe("malformed and unknown requests", () => {
  it("returns 400 for a body that is not Retell's envelope", async () => {
    const response = await checkRoute(rawRequest(JSON.stringify({ nonsense: true })));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
  });

  it("returns 400 for a body that is not JSON at all", async () => {
    const response = await checkRoute(rawRequest("not json"));
    expect(response.status).toBe(400);
  });

  it("returns 404 for a call_id nothing knows about", async () => {
    const body = fixture("check-availability");
    (body.call as { call_id: string }).call_id = "call_never_existed";

    const response = await checkRoute(rawRequest(JSON.stringify(body)));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "unknown_call" });
  });
});

describe("the full negotiation, as Retell would drive it", () => {
  it("checks, books, keeps checking, and refuses the second booking", async () => {
    // 1. She cannot make her time, so Maya asks what is open.
    const first = await (await checkRoute(toolRequest("check-availability"))).json();
    expect(first.ok).toBe(true);
    expect(first.slots.length).toBeGreaterThan(1);

    // 2. She rejects those, so Maya asks again. Offers are unlimited (SPEC.md §7).
    const second = await (await checkRoute(toolRequest("check-availability"))).json();
    expect(second.slots.length).toBeGreaterThan(1);

    // 3. She takes the second one Maya read out.
    const booked = await (
      await bookSlotRoute(toolRequest("book-slot", { slotStart: second.slots[1].slot_start }))
    ).json();
    expect(booked.ok).toBe(true);
    expect(booked.booked_time).toBe(second.slots[1].time);

    // 4. Further checks still work — the cap is on Reschedules, not on Offers.
    const third = await (await checkRoute(toolRequest("check-availability"))).json();
    expect(third.ok).toBe(true);
    expect(third.slots.length).toBeGreaterThan(0);

    // 5. A second Reschedule is refused.
    const again = await (
      await bookSlotRoute(toolRequest("book-slot", { slotStart: third.slots[0].slot_start }))
    ).json();
    expect(again).toEqual({
      ok: false,
      reason: "already_booked",
      say: COMMITTED.alreadyBooked,
    });

    // The Appointment sits where the first booking put it.
    const appointment = await db.query.appointments.findFirst({
      where: eq(schema.appointments.id, seed.appointmentId),
    });
    expect(appointment!.startsAt.toISOString()).toBe(second.slots[1].slot_start);
    expect(appointment!.status).toBe("rescheduled");
  });

  it("records every invocation with its arguments, result and success flag", async () => {
    await checkRoute(toolRequest("check-availability"));
    const offered = await (await checkRoute(toolRequest("check-availability"))).json();
    await bookSlotRoute(toolRequest("book-slot", { slotStart: offered.slots[0].slot_start }));
    await bookSlotRoute(toolRequest("book-slot", { slotStart: offered.slots[1].slot_start }));

    const rows = await db
      .select()
      .from(schema.toolInvocations)
      .where(eq(schema.toolInvocations.callId, seed.callId));

    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.arguments).toBeTypeOf("object");
      expect(row.result).not.toBeNull();
      expect(row.succeeded).toBeTypeOf("boolean");
      // Acceptance criterion 6: a slow Tool is dead air on a live call.
      expect(row.latencyMs).toBeTypeOf("number");
      expect(row.latencyMs).toBeGreaterThanOrEqual(0);
    }

    const bookings = rows.filter((r) => r.toolName === "book_slot");
    expect(bookings.filter((r) => r.succeeded)).toHaveLength(1);
    expect(bookings.filter((r) => !r.succeeded)).toHaveLength(1);

    // The recorded arguments are the ones the model actually sent.
    const check = rows.find((r) => r.toolName === "check_availability");
    expect(check!.arguments).toEqual({ preferred_time: "Thursday afternoon" });
  });

  it("confirms the existing time", async () => {
    const response = await confirmRoute(toolRequest("confirm-appointment"));
    expect(await response.json()).toEqual({ ok: true, say: COMMITTED.confirmed });

    const appointment = await db.query.appointments.findFirst({
      where: eq(schema.appointments.id, seed.appointmentId),
    });
    expect(appointment!.status).toBe("confirmed");
    expect(appointment!.startsAt).toEqual(APPOINTMENT_STARTS_AT);
  });

  it("cancels and frees the Slot", async () => {
    const response = await cancelRoute(toolRequest("cancel-appointment"));
    expect(await response.json()).toEqual({ ok: true, say: COMMITTED.cancelled });

    const appointment = await db.query.appointments.findFirst({
      where: eq(schema.appointments.id, seed.appointmentId),
    });
    expect(appointment!.status).toBe("cancelled");
  });

  it("refuses a Slot the Agent invented rather than copied", async () => {
    // 13:00 Asia/Kolkata — open, in hours, and never among the three Slots
    // check_availability returns. The rule that stops a hallucinated time
    // becoming a booking.
    const offered = await (await checkRoute(toolRequest("check-availability"))).json();
    const invented = "2026-08-17T07:30:00.000Z";
    expect(offered.slots.map((s: { slot_start: string }) => s.slot_start)).not.toContain(
      invented,
    );

    const response = await bookSlotRoute(toolRequest("book-slot", { slotStart: invented }));
    expect(await response.json()).toEqual({
      ok: false,
      reason: "not_offered",
      say: NOT_COMMITTED.notAvailable,
    });

    const appointment = await db.query.appointments.findFirst({
      where: eq(schema.appointments.id, seed.appointmentId),
    });
    expect(appointment!.startsAt).toEqual(APPOINTMENT_STARTS_AT);
  });
});

describe("the negotiation SPEC.md §7 describes", () => {
  it("offers different times each round and books one of the later ones", async () => {
    // "10am is unavailable, so offer noon; noon is refused, so offer 4pm; 4pm is
    // free, so book it and read it back." Unlimited Offers, exactly one commit.
    const first = await (await checkRoute(toolRequest("check-availability"))).json();
    expect(first.slots.length).toBeGreaterThan(0);

    const second = await (await checkRoute(toolRequest("check-availability"))).json();
    expect(second.slots.length).toBeGreaterThan(0);

    const alreadySaid = first.slots.map((s: OfferedRow) => s.slot_start);
    for (const slot of second.slots as OfferedRow[]) {
      expect(alreadySaid).not.toContain(slot.slot_start);
    }

    const agreed = second.slots[0] as OfferedRow;
    const booked = await (
      await bookSlotRoute(toolRequest("book-slot", { slotStart: agreed.slot_start }))
    ).json();

    expect(booked.ok).toBe(true);
    expect(booked.booked_time).toBe(agreed.time);
    expect(booked.say).toBe(COMMITTED.booked(agreed.time));

    // The row has moved, and it moved during the call rather than afterwards.
    const appointment = await db.query.appointments.findFirst({
      where: eq(schema.appointments.id, seed.appointmentId),
    });
    expect(appointment!.startsAt.toISOString()).toBe(agreed.slot_start);
    expect(appointment!.status).toBe("rescheduled");
    expect(appointment!.needsAttentionReason).toBeNull();
  });

  it("still honours a time from an earlier round", async () => {
    // "Actually, the first one you said" is a real thing people say. The
    // endpoint refuses to re-offer a time; it does not refuse to honour one.
    const first = await (await checkRoute(toolRequest("check-availability"))).json();
    await checkRoute(toolRequest("check-availability"));

    const wanted = first.slots[0] as OfferedRow;
    const booked = await (
      await bookSlotRoute(toolRequest("book-slot", { slotStart: wanted.slot_start }))
    ).json();

    expect(booked.ok).toBe(true);
    expect(booked.booked_time).toBe(wanted.time);
  });

  it("promises a callback when the Slot goes, and never claims success", async () => {
    // SPEC.md §8, the path that matters more than the happy one. Forced from a
    // fixture and seeded state, with no telephony spend (SPEC.md §10).
    const offered = await (await checkRoute(toolRequest("check-availability"))).json();
    const agreed = offered.slots[0] as OfferedRow;

    // Another Call takes it between the Offer and the booking.
    await occupy(agreed.slot_start);

    const response = await bookSlotRoute(
      toolRequest("book-slot", { slotStart: agreed.slot_start }),
    );
    const body = await response.json();

    // A business refusal is part of the conversation, not a broken request.
    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: false,
      reason: "slot_taken",
      say: NOT_COMMITTED.bookFailed,
    });
    // SPEC.md §3 rule 7, as one assertion.
    expect(body.booked_time).toBeUndefined();
    expect(body.say).toContain("call you back");

    const appointment = await db.query.appointments.findFirst({
      where: eq(schema.appointments.id, seed.appointmentId),
    });
    // The Appointment keeps its original Slot (SPEC.md §8 step 3)...
    expect(appointment!.startsAt).toEqual(APPOINTMENT_STARTS_AT);
    // ...and a human is asked to look at it.
    expect(appointment!.needsAttentionReason).toBe("book_failed");

    // The retry is silent to the customer, not to the record.
    const rows = await db
      .select()
      .from(schema.toolInvocations)
      .where(eq(schema.toolInvocations.callId, seed.callId));
    const booking = rows.find((r) => r.toolName === "book_slot");
    expect(booking!.succeeded).toBe(false);
    expect(booking!.arguments).toEqual({ slot_start: agreed.slot_start });
  });

  it("keeps talking after a failed booking", async () => {
    // She has to be able to offer something else. A failed book_slot is not the
    // end of the conversation, and it must not have consumed the one commit.
    const offered = await (await checkRoute(toolRequest("check-availability"))).json();
    const gone = offered.slots[0] as OfferedRow;
    await occupy(gone.slot_start);
    await bookSlotRoute(toolRequest("book-slot", { slotStart: gone.slot_start }));

    const next = await (await checkRoute(toolRequest("check-availability"))).json();
    expect(next.slots.length).toBeGreaterThan(0);

    const second = next.slots[0] as OfferedRow;
    const booked = await (
      await bookSlotRoute(toolRequest("book-slot", { slotStart: second.slot_start }))
    ).json();
    expect(booked.ok).toBe(true);
  });
});

describe("the declared paths and the routes on disk agree", () => {
  it.each(Object.entries(TOOL_PATHS))("%s is served at %s", (_name, path) => {
    // lib/retell/tools.ts bakes these into every Agent at creation time, so a
    // renamed directory would 404 mid-call and `npm run create-agents` would
    // never notice. A URL path maps to a directory under app/ — that is the App
    // Router's whole convention, and it is what makes this assertable at all.
    expect(() => readFileSync(`./app${path}/route.ts`, "utf8")).not.toThrow();
  });
});
