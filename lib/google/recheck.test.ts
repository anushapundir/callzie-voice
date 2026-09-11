import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import { encryptSecret } from "@/lib/google/crypto";
import { recheckCollisions } from "@/lib/google/recheck";
import { cleanupToolTest, seedToolTest } from "@/lib/tools/testing";

/*
  The re-check is what catches an event the owner adds AFTER Callzie booked —
  the case the push-time read can never see, and the one the acceptance
  criterion actually describes.

  Two properties are asserted hardest: it costs exactly one events.list call
  however many Appointments there are, and it is bounded, which is the note
  lib/business/needs-attention.ts leaves for this ticket.
*/

const CLERK_ID = "google-recheck-test";
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const NOW = new Date("2026-09-01T04:00:00Z");
/** 14:00 Kolkata, later the same day as NOW. */
const SEEDED_AT = new Date("2026-09-01T08:30:00Z");

let businessId: string;
let serviceId: string;
let appointmentId: string;

function fakeGoogle(items: unknown[] = []) {
  const requests: { method: string; url: string }[] = [];

  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    const asString = typeof url === "string" ? url : url.toString();
    requests.push({ method: init?.method ?? "GET", url: asString });

    if (asString.startsWith("https://oauth2.googleapis.com/token")) {
      return Promise.resolve(json({ access_token: "ya29.fresh" }));
    }
    return Promise.resolve(json({ items }));
  }) as unknown as typeof fetch;

  return {
    impl,
    lists: () => requests.filter((r) => r.url.includes("/calendar/v3/")),
    requests,
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** An extra Appointment at `startsAt`, one hour long. */
async function addAppointment(startsAt: Date, name = "Extra"): Promise<string> {
  const [row] = await db
    .insert(schema.appointments)
    .values({
      businessId,
      serviceId,
      name,
      phoneE164: "+919876543211",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
      status: "pending",
    })
    .returning();
  return row.id;
}

async function reasonOf(id: string): Promise<string | null> {
  const row = await db.query.appointments.findFirst({
    where: eq(schema.appointments.id, id),
  });
  return row?.needsAttentionReason ?? null;
}

beforeAll(async () => {
  await cleanupToolTest(CLERK_ID);
  const seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: SEEDED_AT,
  });
  businessId = seed.businessId;
  serviceId = seed.serviceId;
  appointmentId = seed.appointmentId;

  await db
    .update(schema.businesses)
    .set({
      googleCalendarId: "owner@example.test",
      googleRefreshToken: encryptSecret("1//refresh", KEY),
    })
    .where(eq(schema.businesses.id, businessId));
});

afterAll(async () => {
  await cleanupToolTest(CLERK_ID);
});

beforeEach(async () => {
  process.env.GOOGLE_CLIENT_ID = "1234.apps.googleusercontent.example";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  process.env.TOKEN_ENCRYPTION_KEY = KEY;

  // Remove everything except the seeded Appointment, and reset it.
  const all = await db
    .select({ id: schema.appointments.id })
    .from(schema.appointments)
    .where(eq(schema.appointments.businessId, businessId));
  for (const row of all) {
    if (row.id === appointmentId) continue;
    await db.delete(schema.appointments).where(eq(schema.appointments.id, row.id));
  }
  await db
    .update(schema.appointments)
    .set({
      status: "pending",
      needsAttentionReason: null,
      collisionEventIds: [],
      googleEventId: null,
      startsAt: SEEDED_AT,
      endsAt: new Date(SEEDED_AT.getTime() + 60 * 60_000),
    })
    .where(eq(schema.appointments.id, appointmentId));
});

describe("recheckCollisions", () => {
  it("raises a Collision for an event the owner added after booking", async () => {
    const google = fakeGoogle([
      {
        id: "evt-dentist",
        start: { dateTime: "2026-09-01T09:00:00Z" },
        end: { dateTime: "2026-09-01T09:30:00Z" },
      },
    ]);

    expect(await recheckCollisions(businessId, google.impl, NOW)).toBe(1);
    expect(await reasonOf(appointmentId)).toBe("collision");
  });

  it("costs exactly one events.list call for many Appointments", async () => {
    // The whole reason the helpers take lists. Ten Appointments, one request.
    for (let i = 1; i <= 9; i++) {
      await addAppointment(new Date(SEEDED_AT.getTime() + i * 24 * 60 * 60_000));
    }
    const google = fakeGoogle();

    await recheckCollisions(businessId, google.impl, NOW);

    expect(google.lists()).toHaveLength(1);
  });

  it("ignores an Appointment beyond the fourteen-day horizon", async () => {
    const far = await addAppointment(
      new Date(NOW.getTime() + 20 * 24 * 60 * 60_000),
      "Far future",
    );
    // An event covering the far Appointment's day.
    const google = fakeGoogle([
      {
        id: "evt-far",
        start: { dateTime: new Date(NOW.getTime() + 20 * 24 * 60 * 60_000).toISOString() },
        end: { dateTime: new Date(NOW.getTime() + 20 * 24 * 60 * 60_000 + 3_600_000).toISOString() },
      },
    ]);

    await recheckCollisions(businessId, google.impl, NOW);

    expect(await reasonOf(far)).toBeNull();
  });

  it("ignores a cancelled Appointment", async () => {
    // It holds no Slot, so an overlap with it is a Collision about something
    // that is not happening.
    await db
      .update(schema.appointments)
      .set({ status: "cancelled" })
      .where(eq(schema.appointments.id, appointmentId));

    const google = fakeGoogle([
      {
        id: "evt-dentist",
        start: { dateTime: "2026-09-01T09:00:00Z" },
        end: { dateTime: "2026-09-01T09:30:00Z" },
      },
    ]);

    expect(await recheckCollisions(businessId, google.impl, NOW)).toBe(0);
    expect(await reasonOf(appointmentId)).toBe(null);
  });

  it("ignores an Appointment already in the past", async () => {
    await db
      .update(schema.appointments)
      .set({
        startsAt: new Date(NOW.getTime() - 3_600_000),
        endsAt: new Date(NOW.getTime() - 1_800_000),
      })
      .where(eq(schema.appointments.id, appointmentId));

    const google = fakeGoogle();
    expect(await recheckCollisions(businessId, google.impl, NOW)).toBe(0);
    expect(google.lists()).toHaveLength(0);
  });

  it("makes no request when nothing is in range", async () => {
    /*
      Moved past the horizon rather than deleted — the seeded Appointment has a
      `calls` row pointing at it, which is the shape every real Appointment ends
      up in once it has been phoned.

      The assertion is that a Business with nothing to check costs no network at
      all, not merely no Collisions.
    */
    const beyond = new Date(NOW.getTime() + 30 * 24 * 60 * 60_000);
    await db
      .update(schema.appointments)
      .set({ startsAt: beyond, endsAt: new Date(beyond.getTime() + 3_600_000) })
      .where(eq(schema.appointments.id, appointmentId));

    const google = fakeGoogle();
    expect(await recheckCollisions(businessId, google.impl, NOW)).toBe(0);
    expect(google.requests).toHaveLength(0);
  });

  it("makes no request for a Business with no Google connection", async () => {
    await db
      .update(schema.businesses)
      .set({ googleRefreshToken: null })
      .where(eq(schema.businesses.id, businessId));

    const google = fakeGoogle();
    expect(await recheckCollisions(businessId, google.impl, NOW)).toBe(0);
    expect(google.requests).toHaveLength(0);

    await db
      .update(schema.businesses)
      .set({ googleRefreshToken: encryptSecret("1//refresh", KEY) })
      .where(eq(schema.businesses.id, businessId));
  });

  it("asks Google for whole local days across the whole span", async () => {
    /*
      Kolkata is UTC+5:30. The seeded Appointment is on 2026-09-01 there, and
      the extra one is two days later, so the window runs from midnight before
      the first to midnight after the last.
    */
    await addAppointment(new Date(SEEDED_AT.getTime() + 2 * 24 * 60 * 60_000));
    const google = fakeGoogle();

    await recheckCollisions(businessId, google.impl, NOW);

    const query = new URL(google.lists()[0].url).searchParams;
    expect(query.get("timeMin")).toBe("2026-08-31T18:30:00.000Z");
    expect(query.get("timeMax")).toBe("2026-09-03T18:30:00.000Z");
  });
});
