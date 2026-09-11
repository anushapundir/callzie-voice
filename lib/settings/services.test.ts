import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { provisionUser } from "@/lib/auth/provision-user";
import { db, schema } from "@/lib/db";
import { addService, deleteService, updateService } from "@/lib/settings/services";

/*
  Integration against the real Postgres named by DATABASE_URL, per
  vitest.config.mts. Everything worth testing here is a fact about rows —
  whether a `WHERE` clause is scoped to the Business, whether `count()` sees an
  Appointment, whether the `appointments_service_id_services_id_fk` FK would
  have fired — so a mocked db would only test the mock.

  Two Businesses throughout. A single-Business fixture cannot tell a query
  scoped by `business_id` from one that forgot to be, which is the failure mode
  this module exists to prevent.
*/

// Namespaced so a stray row is obviously a test artefact and cleanup can never
// touch a real account.
const CLERK_IDS = ["user_test_settings_services_a", "user_test_settings_services_b"];
const TIMEZONE = "Asia/Kolkata";

/** The Business under test, and a neighbour whose rows must stay untouched. */
let businessId: string;
let otherBusinessId: string;

/**
 * Deletes in foreign-key order. Every FK in this schema is ON DELETE NO ACTION,
 * so removing the Business first fails, leaves fixtures behind, and poisons the
 * next run against the same database.
 */
async function cleanup() {
  const users = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(inArray(schema.users.clerkId, CLERK_IDS));
  if (users.length === 0) return;

  const businesses = await db
    .select({ id: schema.businesses.id })
    .from(schema.businesses)
    .where(
      inArray(
        schema.businesses.userId,
        users.map((user) => user.id),
      ),
    );
  const businessIds = businesses.map((business) => business.id);

  if (businessIds.length > 0) {
    await db
      .delete(schema.appointments)
      .where(inArray(schema.appointments.businessId, businessIds));
    await db
      .delete(schema.services)
      .where(inArray(schema.services.businessId, businessIds));
    await db
      .delete(schema.businessHours)
      .where(inArray(schema.businessHours.businessId, businessIds));
    await db
      .delete(schema.businesses)
      .where(inArray(schema.businesses.id, businessIds));
  }

  await db.delete(schema.users).where(inArray(schema.users.clerkId, CLERK_IDS));
}

/**
 * A bare Business, inserted directly rather than through
 * `createOnboardedBusiness`. Onboarding seeds Services *and* Appointments
 * against them, which is precisely the state each test here wants to build for
 * itself — the delete guards are only meaningful when the fixture controls
 * exactly how many of each exist.
 */
async function makeBusiness(clerkId: string): Promise<string> {
  const user = await provisionUser(clerkId, `${clerkId}@example.com`);
  const [business] = await db
    .insert(schema.businesses)
    .values({
      userId: user.id,
      name: "Test Business",
      businessType: "salon",
      timezone: TIMEZONE,
    })
    .returning({ id: schema.businesses.id });
  return business.id;
}

async function makeService(
  ownerId: string,
  name: string,
  durationMinutes = 30,
): Promise<string> {
  const [service] = await db
    .insert(schema.services)
    .values({ businessId: ownerId, name, durationMinutes })
    .returning({ id: schema.services.id });
  return service.id;
}

/** Non-overlapping by construction — `appointments_no_overlap` is per Business. */
let appointmentSlot = 0;

async function makeAppointment(ownerId: string, serviceId: string) {
  const startsAt = new Date(
    Date.UTC(2030, 0, 1, 6 + appointmentSlot++ * 2, 0, 0),
  );
  const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
  await db.insert(schema.appointments).values({
    businessId: ownerId,
    serviceId,
    name: "Test Caller",
    // The reserved fictional range, as everywhere else in this repo.
    phoneE164: "+12025550199",
    startsAt,
    endsAt,
  });
}

function servicesOf(ownerId: string) {
  return db
    .select()
    .from(schema.services)
    .where(eq(schema.services.businessId, ownerId));
}

beforeEach(async () => {
  await cleanup();
  appointmentSlot = 0;
  businessId = await makeBusiness(CLERK_IDS[0]);
  otherBusinessId = await makeBusiness(CLERK_IDS[1]);
});

afterEach(cleanup);

describe("addService", () => {
  it("writes the Service against the Business that asked for it", async () => {
    const result = await addService(businessId, {
      name: "Blow-dry",
      durationMinutes: 30,
    });

    expect(result.ok).toBe(true);
    const [service] = await servicesOf(businessId);
    expect(service.name).toBe("Blow-dry");
    expect(service.durationMinutes).toBe(30);
    expect(await servicesOf(otherBusinessId)).toHaveLength(0);
  });

  it("refuses a name this Business already uses, whatever the case", async () => {
    await makeService(businessId, "Haircut");

    const result = await addService(businessId, {
      name: "haircut",
      durationMinutes: 45,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // On the field, not the form — the name box is what has to change.
    expect(result.errors.name).toBeDefined();
    expect(await servicesOf(businessId)).toHaveLength(1);
  });

  it("does not treat `_` in an existing name as a wildcard", async () => {
    // The bug an `ilike` comparison would have: "Cut _ Colour" matching
    // "Cut & Colour". Uniqueness here means equality ignoring case, not a match.
    await makeService(businessId, "Cut _ Colour");

    const result = await addService(businessId, {
      name: "Cut & Colour",
      durationMinutes: 90,
    });

    expect(result.ok).toBe(true);
    expect(await servicesOf(businessId)).toHaveLength(2);
  });

  it("lets a different Business use the same name", async () => {
    await makeService(otherBusinessId, "Haircut");

    const result = await addService(businessId, {
      name: "Haircut",
      durationMinutes: 45,
    });

    expect(result.ok).toBe(true);
  });
});

describe("updateService", () => {
  it("renames and re-times the Service", async () => {
    const serviceId = await makeService(businessId, "Haircut", 45);

    const result = await updateService(businessId, serviceId, {
      name: "Cut and finish",
      durationMinutes: 60,
    });

    expect(result.ok).toBe(true);
    const [service] = await servicesOf(businessId);
    expect(service.name).toBe("Cut and finish");
    expect(service.durationMinutes).toBe(60);
  });

  it("lets a Service keep its own name", async () => {
    // The duplicate check has to exclude the row being edited, or saving a
    // duration change without touching the name collides with itself.
    const serviceId = await makeService(businessId, "Haircut", 45);

    const result = await updateService(businessId, serviceId, {
      name: "Haircut",
      durationMinutes: 60,
    });

    expect(result.ok).toBe(true);
  });

  it("refuses a name a sibling Service already holds", async () => {
    const serviceId = await makeService(businessId, "Haircut");
    await makeService(businessId, "Colour");

    const result = await updateService(businessId, serviceId, {
      name: "COLOUR",
      durationMinutes: 45,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.name).toBeDefined();
  });

  it("leaves Appointments already booked against it alone", async () => {
    // `ends_at` is derived from the duration at write time. Rewriting booked
    // rows could push one into its neighbour and fail `appointments_no_overlap`
    // on data the person editing Settings cannot see.
    const serviceId = await makeService(businessId, "Haircut", 45);
    await makeAppointment(businessId, serviceId);
    const [before] = await db
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.businessId, businessId));

    await updateService(businessId, serviceId, {
      name: "Haircut",
      durationMinutes: 120,
    });

    const [after] = await db
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.businessId, businessId));
    expect(after.endsAt).toEqual(before.endsAt);
  });

  describe("an id that is not this Business's", () => {
    it("refuses another Business's Service and does not write to it", async () => {
      const theirs = await makeService(otherBusinessId, "Haircut", 45);

      const result = await updateService(businessId, theirs, {
        name: "Renamed by a stranger",
        durationMinutes: 60,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.form).toBeDefined();

      const [untouched] = await servicesOf(otherBusinessId);
      expect(untouched.name).toBe("Haircut");
      expect(untouched.durationMinutes).toBe(45);
    });

    it("says the same thing about a stranger's row as about a deleted one", async () => {
      // Distinguishable messages would make this endpoint confirm whether a
      // given uuid names a real row in someone else's Services.
      const theirs = await makeService(otherBusinessId, "Haircut");
      const gone = "00000000-0000-4000-8000-000000000000";
      const input = { name: "Anything", durationMinutes: 30 };

      const [stranger, missing] = await Promise.all([
        updateService(businessId, theirs, input),
        updateService(businessId, gone, input),
      ]);

      expect(stranger.ok).toBe(false);
      expect(missing.ok).toBe(false);
      if (stranger.ok || missing.ok) return;
      expect(stranger.errors.form).toBe(missing.errors.form);
    });

    it("survives an id that is not a uuid at all", async () => {
      // `services.id` is `uuid`; comparing it against junk raises `invalid
      // input syntax for type uuid` rather than returning zero rows, and anyone
      // can post junk.
      const result = await updateService(businessId, "not-a-uuid", {
        name: "Anything",
        durationMinutes: 30,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.form).toBeDefined();
    });
  });
});

describe("deleteService", () => {
  it("removes a Service nothing points at", async () => {
    const serviceId = await makeService(businessId, "Haircut");
    await makeService(businessId, "Colour");

    const result = await deleteService(businessId, serviceId);

    expect(result.ok).toBe(true);
    const remaining = await servicesOf(businessId);
    expect(remaining.map((service) => service.name)).toEqual(["Colour"]);
  });

  it("refuses while Appointments reference it, rather than letting the FK fire", async () => {
    // `appointments.service_id` is NOT NULL ON DELETE no action, so an
    // unguarded delete reaches the user as an unhandled Postgres error.
    const serviceId = await makeService(businessId, "Haircut");
    await makeService(businessId, "Colour");
    await makeAppointment(businessId, serviceId);
    await makeAppointment(businessId, serviceId);
    await makeAppointment(businessId, serviceId);

    const result = await deleteService(businessId, serviceId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.form).toBe(
      "3 appointments use this service, so it cannot be removed.",
    );
    expect(await servicesOf(businessId)).toHaveLength(2);
  });

  it("counts one Appointment in the singular", async () => {
    const serviceId = await makeService(businessId, "Haircut");
    await makeService(businessId, "Colour");
    await makeAppointment(businessId, serviceId);

    const result = await deleteService(businessId, serviceId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.form).toBe(
      "1 appointment uses this service, so it cannot be removed.",
    );
  });

  it("refuses the last remaining Service", async () => {
    // A Business with no Services can hold no Appointment — `service_id` is NOT
    // NULL. That is the unusable state issue #5 exists to prevent.
    const serviceId = await makeService(businessId, "Haircut");

    const result = await deleteService(businessId, serviceId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.form).toBeDefined();
    expect(await servicesOf(businessId)).toHaveLength(1);
  });

  it("counts only this Business's Services when deciding that", async () => {
    // Two Services exist in the database, one of them a stranger's. Deleting
    // this Business's only Service must still be refused.
    const serviceId = await makeService(businessId, "Haircut");
    await makeService(otherBusinessId, "Colour");

    const result = await deleteService(businessId, serviceId);

    expect(result.ok).toBe(false);
    const [survivor] = await servicesOf(businessId);
    expect(survivor.id).toBe(serviceId);
  });

  it("refuses another Business's Service and leaves it in place", async () => {
    const theirs = await makeService(otherBusinessId, "Haircut");
    await makeService(otherBusinessId, "Colour");

    const result = await deleteService(businessId, theirs);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.form).toBe("That service no longer exists.");
    expect(await servicesOf(otherBusinessId)).toHaveLength(2);
  });

  it("does not delete a Service that is referenced from outside its own Business", async () => {
    /*
      Nothing in the schema forces `appointments.business_id` to agree with its
      Service's, so the FK can be satisfied by a row this Business cannot see.
      A count scoped by `business_id` would report zero and the delete would
      fail on the constraint instead of on this guard.
    */
    const serviceId = await makeService(businessId, "Haircut");
    await makeService(businessId, "Colour");
    await makeAppointment(otherBusinessId, serviceId);

    const result = await deleteService(businessId, serviceId);

    expect(result.ok).toBe(false);
    expect(
      await db
        .select()
        .from(schema.services)
        .where(
          and(
            eq(schema.services.id, serviceId),
            eq(schema.services.businessId, businessId),
          ),
        ),
    ).toHaveLength(1);
  });
});
