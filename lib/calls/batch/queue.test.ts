import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  batchProgress,
  enqueueBatch,
  markUnreachable,
  requeueForRetry,
  stopBatch,
} from "@/lib/calls/batch/queue";
import { db, schema } from "@/lib/db";
import type { AppointmentStatus } from "@/lib/db/schema";
import {
  cleanupToolTest,
  seedToolTest,
  type ToolTestSeed,
} from "@/lib/tools/testing";

/*
  The queue, and the two writes a finished Call triggers.

  The rule these tests exist for is "keeps the Slot": an unreachable Appointment
  keeps its Slot and its time (SPEC.md §14 rule 2). Freeing a Slot because
  nobody picked up the phone would destroy a real booking on the weakest signal
  available.
*/

const CLERK_ID = "user_test_batch_queue";
const NOW = new Date("2026-09-01T00:00:00.000Z");
const STARTS_AT = new Date("2026-09-14T04:30:00.000Z");

let seed: ToolTestSeed;

async function addAppointment(startsAt: Date) {
  const [row] = await db
    .insert(schema.appointments)
    .values({
      businessId: seed.businessId,
      serviceId: seed.serviceId,
      name: "Second Person",
      phoneE164: "+919876543211",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
      status: "pending",
    })
    .returning();
  return row;
}

async function appointment(id: string = seed.appointmentId) {
  return db.query.appointments.findFirst({
    where: eq(schema.appointments.id, id),
  });
}

async function setStatus(
  status: AppointmentStatus,
  id: string = seed.appointmentId,
) {
  await db
    .update(schema.appointments)
    .set({ status })
    .where(eq(schema.appointments.id, id));
}

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: STARTS_AT,
  });
  await setStatus("pending");
});

afterEach(() => cleanupToolTest(CLERK_ID));

describe("enqueueBatch", () => {
  it("queues every callable Appointment", async () => {
    await addAppointment(new Date("2026-09-15T04:30:00.000Z"));

    expect(
      await enqueueBatch({ businessId: seed.businessId, now: NOW }),
    ).toEqual({ queued: 2, eligible: 2 });
    expect((await appointment())?.status).toBe("queued");
  });

  it("queues no more than the Quota allows", async () => {
    await addAppointment(new Date("2026-09-15T04:30:00.000Z"));
    await addAppointment(new Date("2026-09-16T04:30:00.000Z"));
    await db
      .update(schema.businesses)
      .set({ callsUsed: 4, callQuota: 5 })
      .where(eq(schema.businesses.id, seed.businessId));

    // Issue #17: the Quota is respected across the whole batch, not per Call.
    expect(
      await enqueueBatch({ businessId: seed.businessId, now: NOW }),
    ).toEqual({ queued: 1, eligible: 3 });
  });

  it("queues nothing twice, so a double press is harmless", async () => {
    await enqueueBatch({ businessId: seed.businessId, now: NOW });

    expect(
      await enqueueBatch({ businessId: seed.businessId, now: NOW }),
    ).toEqual({ queued: 0, eligible: 0 });
  });
});

describe("stopBatch", () => {
  it("returns the waiting Appointments to pending", async () => {
    await enqueueBatch({ businessId: seed.businessId, now: NOW });

    expect(await stopBatch(seed.businessId)).toBe(1);
    expect((await appointment())?.status).toBe("pending");
  });

  it("leaves a Call already in flight alone", async () => {
    await setStatus("calling");

    expect(await stopBatch(seed.businessId)).toBe(0);
    expect((await appointment())?.status).toBe("calling");
  });
});

describe("requeueForRetry", () => {
  it("puts the Appointment back in the queue", async () => {
    await requeueForRetry(seed.appointmentId);

    expect((await appointment())?.status).toBe("queued");
  });

  it("leaves an outcome a Tool committed alone", async () => {
    // The Tool wins (SPEC.md §9 step 3). A confirmed Appointment must never be
    // dragged back into a queue by a late webhook.
    await setStatus("confirmed");

    await requeueForRetry(seed.appointmentId);

    expect((await appointment())?.status).toBe("confirmed");
  });

  it("refuses an Appointment that needs attention", async () => {
    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: "book_failed" })
      .where(eq(schema.appointments.id, seed.appointmentId));

    await requeueForRetry(seed.appointmentId);

    expect((await appointment())?.status).toBe("pending");
  });

  it("leaves an Appointment already waiting where it is", async () => {
    await setStatus("queued");

    await requeueForRetry(seed.appointmentId);

    expect((await appointment())?.status).toBe("queued");
  });
});

describe("markUnreachable", () => {
  it("stops calling and asks for a human", async () => {
    await markUnreachable(seed.appointmentId);

    const row = await appointment();
    expect(row?.status).toBe("unreachable");
    expect(row?.needsAttentionReason).toBe("unreachable");
  });

  it("keeps the Slot, which is the whole point", async () => {
    // SPEC.md §14 rule 2. `unreachable` is not in SLOT_FREEING_STATUSES, and
    // the time itself must not move either.
    await markUnreachable(seed.appointmentId);

    expect((await appointment())?.startsAt.getTime()).toBe(STARTS_AT.getTime());
  });

  it("does not overwrite a more specific reason", async () => {
    // `book_failed` says the Call tried to book and could not, which is more
    // than "nobody answered". The same rule flagTruncated follows.
    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: "book_failed" })
      .where(eq(schema.appointments.id, seed.appointmentId));

    await markUnreachable(seed.appointmentId);

    const row = await appointment();
    expect(row?.status).toBe("unreachable");
    expect(row?.needsAttentionReason).toBe("book_failed");
  });

  it("is a no-op on a delivery that arrives twice", async () => {
    await markUnreachable(seed.appointmentId);
    await markUnreachable(seed.appointmentId);

    expect((await appointment())?.needsAttentionReason).toBe("unreachable");
  });

  it("gives up on an Appointment still waiting in the queue", async () => {
    /*
      The state the second silence actually finds it in. A retry that cannot be
      placed — every account today, because the phone flag is off — sits at
      `queued`, and keying this write on `pending` alone left it stuck there
      forever. Found by scripts/replay-webhook.ts.
    */
    await setStatus("queued");

    await markUnreachable(seed.appointmentId);

    const row = await appointment();
    expect(row?.status).toBe("unreachable");
    expect(row?.needsAttentionReason).toBe("unreachable");
  });

  it("still refuses an outcome a Tool committed", async () => {
    await setStatus("confirmed");

    await markUnreachable(seed.appointmentId);

    expect((await appointment())?.status).toBe("confirmed");
  });
});

describe("batchProgress", () => {
  it("counts what is waiting and what is being called", async () => {
    const second = await addAppointment(new Date("2026-09-15T04:30:00.000Z"));
    await enqueueBatch({ businessId: seed.businessId, now: NOW });
    await setStatus("calling", second.id);
    await db.insert(schema.calls).values({
      businessId: seed.businessId,
      appointmentId: second.id,
      callType: "phone",
      status: "in_progress",
      createdAt: NOW,
    });

    expect(await batchProgress(seed.businessId, NOW)).toEqual({
      calling: 1,
      waiting: 1,
    });
  });

  it("does not count a live Web Call, which the live-call bar already shows", async () => {
    await db
      .update(schema.calls)
      .set({ status: "in_progress", createdAt: NOW })
      .where(eq(schema.calls.id, seed.callId));

    expect(await batchProgress(seed.businessId, NOW)).toEqual({
      calling: 0,
      waiting: 0,
    });
  });
});
