import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { provisionUser } from "@/lib/auth/provision-user";
import { db, schema } from "@/lib/db";
import { BUSINESS_TYPES } from "@/lib/db/schema";
import { createOnboardedBusiness } from "@/lib/onboarding/create-business";
import { templateFor } from "@/lib/onboarding/templates";
import { changeBusinessType } from "@/lib/settings/business-type";
import { parseBusinessTypeInput } from "@/lib/settings/business-type-input";

/*
  `parseBusinessTypeInput` needs nothing; `changeBusinessType` needs the real
  Postgres named by DATABASE_URL, per vitest.config.mts. The fixtures are set up
  inside the describe blocks that use them so the pure half of this file still
  runs when no database is reachable.

  The claim under test is a negative one — that a type change leaves
  Appointments, Services and Business Hours exactly as they were — and a
  negative claim about rows can only be checked against rows.
*/

const CLERK_ID = "user_test_settings_business_type";
const TIMEZONE = "Asia/Kolkata";
const NOW = new Date("2026-08-13T09:00:00.000Z");

function formData(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

describe("parseBusinessTypeInput", () => {
  it("narrows a member of BUSINESS_TYPES", () => {
    for (const businessType of BUSINESS_TYPES) {
      const parsed = parseBusinessTypeInput(formData({ businessType }));
      expect(parsed.ok, businessType).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value).toBe(businessType);
    }
  });

  it("rejects a value outside BUSINESS_TYPES", () => {
    // `business_type` is `text`, not a pg enum, so nothing but this stops
    // `restaurant` reaching the column — where no Template and no
    // `retell_agents` row would answer to it.
    const parsed = parseBusinessTypeInput(formData({ businessType: "restaurant" }));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.businessType).toBeDefined();
  });

  it("rejects a missing field", () => {
    const parsed = parseBusinessTypeInput(new FormData());

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors.businessType).toBeDefined();
  });

  it("ignores unrelated fields, including Next's own", () => {
    const parsed = parseBusinessTypeInput(
      formData({ businessType: "clinic", $ACTION_ID_abc: "junk" }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toBe("clinic");
  });
});

describe("changeBusinessType", () => {
  let businessId: string;

  /**
   * Deletes in foreign-key order. Every FK in this schema is ON DELETE NO
   * ACTION, so removing the Business first fails, leaves fixtures behind, and
   * poisons the next run against the same database.
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
      await db
        .delete(schema.services)
        .where(eq(schema.services.businessId, business.id));
      await db
        .delete(schema.businessHours)
        .where(eq(schema.businessHours.businessId, business.id));
      await db.delete(schema.businesses).where(eq(schema.businesses.id, business.id));
    }

    await db.delete(schema.users).where(eq(schema.users.clerkId, CLERK_ID));
  }

  /** Every row a type change is forbidden to touch, in a comparable order. */
  async function ownedRows(id: string) {
    const [hours, services, appointments] = await Promise.all([
      db
        .select()
        .from(schema.businessHours)
        .where(eq(schema.businessHours.businessId, id))
        .orderBy(asc(schema.businessHours.weekday)),
      db
        .select()
        .from(schema.services)
        .where(eq(schema.services.businessId, id))
        .orderBy(asc(schema.services.name)),
      db
        .select()
        .from(schema.appointments)
        .where(eq(schema.appointments.businessId, id))
        .orderBy(asc(schema.appointments.startsAt)),
    ]);
    return { hours, services, appointments };
  }

  beforeEach(async () => {
    await cleanup();
    const user = await provisionUser(CLERK_ID, "settings@example.com");
    // Onboarded as a salon, so the fixture carries a full Template's worth of
    // seeded rows for the change to be forbidden to touch.
    const { business } = await createOnboardedBusiness(
      { userId: user.id, name: "Test Business", businessType: "salon", timezone: TIMEZONE },
      NOW,
    );
    businessId = business.id;
  });

  afterEach(cleanup);

  it("writes the new type", async () => {
    await changeBusinessType(businessId, "clinic");

    const business = await db.query.businesses.findFirst({
      where: eq(schema.businesses.id, businessId),
    });
    expect(business?.businessType).toBe("clinic");
  });

  it("leaves every Appointment, Service and Business Hours row exactly as it was", async () => {
    const before = await ownedRows(businessId);

    await changeBusinessType(businessId, "clinic");

    const after = await ownedRows(businessId);
    expect(after.hours).toHaveLength(before.hours.length);
    expect(after.services).toHaveLength(before.services.length);
    expect(after.appointments).toHaveLength(before.appointments.length);
    // Not just the counts: identical rows, so a delete-and-reseed that happened
    // to produce the same number of rows still fails this.
    expect(after).toEqual(before);
  });

  it("does not re-seed from the new Business Type's Template", async () => {
    /*
      The sharpest version of the above. Salon opens Tue–Sat 10:00–19:00 and
      clinic opens Mon–Fri 09:00–17:00, so a re-seed would be visible in the
      weekday set alone. `templateFor` is read at Onboarding and never again.
    */
    await changeBusinessType(businessId, "clinic");

    const { hours, services } = await ownedRows(businessId);
    const salon = templateFor("salon");
    expect(hours.map((row) => row.weekday)).toEqual(
      salon.hours.map((row) => row.weekday),
    );
    expect(services.map((row) => row.name).sort()).toEqual(
      salon.services.map((row) => row.name).sort(),
    );
  });

  it("keeps edits made in Settings before the change", async () => {
    // The realistic case: somebody adjusted their Services, then changed type.
    // A re-seed would silently discard that work.
    await db
      .insert(schema.services)
      .values({ businessId, name: "Bridal package", durationMinutes: 180 });

    await changeBusinessType(businessId, "tutoring");

    const { services } = await ownedRows(businessId);
    expect(services.map((row) => row.name)).toContain("Bridal package");
  });

  it("changes back without accumulating anything", async () => {
    const before = await ownedRows(businessId);

    await changeBusinessType(businessId, "clinic");
    await changeBusinessType(businessId, "salon");

    expect(await ownedRows(businessId)).toEqual(before);
  });

  it("touches no other Business", async () => {
    const others = await db
      .select({ id: schema.businesses.id, businessType: schema.businesses.businessType })
      .from(schema.businesses);
    const before = others.filter((row) => row.id !== businessId);

    await changeBusinessType(businessId, "home_services");

    const after = (
      await db
        .select({
          id: schema.businesses.id,
          businessType: schema.businesses.businessType,
        })
        .from(schema.businesses)
    ).filter((row) => row.id !== businessId);
    expect(after).toEqual(before);
  });
});
