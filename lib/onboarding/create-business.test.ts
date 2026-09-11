import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { provisionUser } from "@/lib/auth/provision-user";
import { db, schema } from "@/lib/db";
import { BUSINESS_TYPES, type BusinessType } from "@/lib/db/schema";
import { createOnboardedBusiness } from "@/lib/onboarding/create-business";
import { templateFor } from "@/lib/onboarding/templates";

/*
  Integration against the real Postgres named by DATABASE_URL, per
  vitest.config.mts. The invariants that matter here — one Business per account,
  and the `appointments_no_overlap` EXCLUDE constraint — live in the schema, so
  a mocked db would only test the mock.
*/

// Namespaced so a stray row is obviously a test artefact and cleanup can never
// touch a real account.
const CLERK_ID = "user_test_create_business";
const TIMEZONE = "Asia/Kolkata";
const NOW = new Date("2026-08-13T09:00:00.000Z");

let userId: string;

/**
 * Deletes in foreign-key order. Every FK in this schema is ON DELETE NO ACTION,
 * so removing the Business first fails, leaves fixtures behind, and poisons the
 * next run against the same database.
 */
async function cleanup() {
  const user = await db.query.users.findFirst({
    where: eq(schema.users.clerkId, CLERK_ID),
  });
  if (!user) return;

  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.userId, user.id),
  });
  if (business) {
    await db
      .delete(schema.appointments)
      .where(eq(schema.appointments.businessId, business.id));
    await db.delete(schema.services).where(eq(schema.services.businessId, business.id));
    await db
      .delete(schema.businessHours)
      .where(eq(schema.businessHours.businessId, business.id));
    await db.delete(schema.businesses).where(eq(schema.businesses.id, business.id));
  }

  await db.delete(schema.users).where(eq(schema.users.clerkId, CLERK_ID));
}

async function childCounts(businessId: string) {
  const [hours, services, appointments] = await Promise.all([
    db
      .select()
      .from(schema.businessHours)
      .where(eq(schema.businessHours.businessId, businessId)),
    db.select().from(schema.services).where(eq(schema.services.businessId, businessId)),
    db
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.businessId, businessId)),
  ]);
  return { hours, services, appointments };
}

function onboard(businessType: BusinessType) {
  return createOnboardedBusiness(
    { userId, name: "Test Business", businessType, timezone: TIMEZONE },
    NOW,
  );
}

beforeEach(async () => {
  await cleanup();
  const user = await provisionUser(CLERK_ID, "onboarding@example.com");
  userId = user.id;
});

afterEach(cleanup);

describe.each(BUSINESS_TYPES)("createOnboardedBusiness(%s)", (businessType) => {
  const template = templateFor(businessType);

  it("writes exactly one Business, on the schema's defaults", async () => {
    const { business, created } = await onboard(businessType);

    expect(created).toBe(true);
    expect(business.businessType).toBe(businessType);
    expect(business.name).toBe("Test Business");
    expect(business.timezone).toBe(TIMEZONE);
    // SPEC.md §12's M2 checkpoint: "quota reads 5".
    expect(business.callQuota).toBe(5);
    expect(business.callsUsed).toBe(0);
    // SPEC.md §3 rule 9: signups get Web Calls only.
    expect(business.phoneCallsEnabled).toBe(false);
    expect(business.isAdmin).toBe(false);

    const all = await db
      .select()
      .from(schema.businesses)
      .where(eq(schema.businesses.userId, userId));
    expect(all).toHaveLength(1);
  });

  it("seeds the Template's Business Hours", async () => {
    const { business } = await onboard(businessType);
    const { hours } = await childCounts(business.id);

    expect(hours).toHaveLength(template.hours.length);
    expect(hours.map((h) => h.weekday).sort()).toEqual(
      template.hours.map((h) => h.weekday).sort(),
    );
    for (const expected of template.hours) {
      const actual = hours.find((h) => h.weekday === expected.weekday);
      // pg `time` comes back with seconds.
      expect(actual?.opensAt).toBe(`${expected.opensAt}:00`);
      expect(actual?.closesAt).toBe(`${expected.closesAt}:00`);
    }
  });

  it("seeds the Template's Services", async () => {
    const { business } = await onboard(businessType);
    const { services } = await childCounts(business.id);

    expect(services).toHaveLength(template.services.length);
    for (const expected of template.services) {
      const actual = services.find((s) => s.name === expected.name);
      expect(actual?.durationMinutes).toBe(expected.durationMinutes);
    }
  });

  it("seeds Appointments pointing only at this Business's own Services", async () => {
    const { business } = await onboard(businessType);
    const { services, appointments } = await childCounts(business.id);

    expect(appointments).toHaveLength(template.appointments.length);
    const ownServiceIds = new Set(services.map((s) => s.id));
    for (const appointment of appointments) {
      expect(ownServiceIds, appointment.name).toContain(appointment.serviceId);
    }
  });

  it("seeds only future Appointments, in the reserved phone range", async () => {
    const { business } = await onboard(businessType);
    const { appointments } = await childCounts(business.id);

    for (const appointment of appointments) {
      expect(appointment.startsAt!.getTime(), appointment.name).toBeGreaterThan(
        NOW.getTime(),
      );
      expect(appointment.endsAt!.getTime()).toBeGreaterThan(
        appointment.startsAt!.getTime(),
      );
      expect(appointment.phoneE164).toMatch(/^\+120255501\d{2}$/);
      // Needs Attention is earned by a real failure (#15), never seeded.
      expect(appointment.needsAttentionReason).toBeNull();
    }
  });
});

describe("createOnboardedBusiness idempotency", () => {
  it("does not seed twice when the same account onboards again", async () => {
    const first = await onboard("salon");
    const second = await onboard("clinic");

    expect(first.created).toBe(true);
    // First write wins: the second call must not rewrite the Business, which is
    // why the upsert is DO NOTHING rather than DO UPDATE.
    expect(second.created).toBe(false);
    expect(second.business.id).toBe(first.business.id);
    expect(second.business.businessType).toBe("salon");

    const template = templateFor("salon");
    const { hours, services, appointments } = await childCounts(first.business.id);
    expect(hours).toHaveLength(template.hours.length);
    expect(services).toHaveLength(template.services.length);
    expect(appointments).toHaveLength(template.appointments.length);
  });

  it("survives two requests racing the first submit", async () => {
    // Two tabs, or a double-click on a slow connection. Postgres blocks the
    // loser on `businesses_user_id_unique` until the winner commits, so there
    // is no window between the read and the write to lose.
    const [a, b] = await Promise.all([onboard("salon"), onboard("salon")]);

    expect(a.business.id).toBe(b.business.id);
    expect([a.created, b.created].sort()).toEqual([false, true]);

    const businesses = await db
      .select()
      .from(schema.businesses)
      .where(eq(schema.businesses.userId, userId));
    expect(businesses).toHaveLength(1);

    const template = templateFor("salon");
    const { hours, services, appointments } = await childCounts(a.business.id);
    expect(hours).toHaveLength(template.hours.length);
    expect(services).toHaveLength(template.services.length);
    expect(appointments).toHaveLength(template.appointments.length);
  });
});
