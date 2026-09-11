import { inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { provisionUser } from "@/lib/auth/provision-user";
import { db, schema } from "@/lib/db";
import { loadSettings } from "@/lib/settings/load-settings";
import { WEEKDAYS } from "@/lib/settings/weekdays";

/*
  Integration against the real Postgres named by DATABASE_URL, per
  vitest.config.mts. Two of the three things this module does exist only because
  of what the driver hands back — a `time` column arriving as `HH:MM:SS`, and a
  `count()` over a LEFT JOIN — so testing it against a fake would test the fake.

  Two Businesses throughout: a query that forgot its `business_id` scope looks
  identical to one that has it until a neighbour exists.
*/

const CLERK_IDS = ["user_test_settings_load_a", "user_test_settings_load_b"];
const TIMEZONE = "Asia/Kolkata";

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
 * `createOnboardedBusiness`: every assertion below is about a specific shape of
 * stored data — a week with gaps in it, a Service nothing references — and a
 * Template's seed is the wrong fixture for either.
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

function makeHours(
  ownerId: string,
  weekday: number,
  opensAt: string,
  closesAt: string,
) {
  return db
    .insert(schema.businessHours)
    .values({ businessId: ownerId, weekday, opensAt, closesAt });
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
  const startsAt = new Date(Date.UTC(2030, 0, 1, 6 + appointmentSlot++ * 2, 0, 0));
  await db.insert(schema.appointments).values({
    businessId: ownerId,
    serviceId,
    name: "Test Caller",
    phoneE164: "+12025550199",
    startsAt,
    endsAt: new Date(startsAt.getTime() + 30 * 60_000),
  });
}

beforeEach(async () => {
  await cleanup();
  appointmentSlot = 0;
  businessId = await makeBusiness(CLERK_IDS[0]);
  otherBusinessId = await makeBusiness(CLERK_IDS[1]);
});

afterEach(cleanup);

describe("loadSettings hours", () => {
  it("returns all seven weekdays in WEEKDAYS order even with no rows stored", async () => {
    // A week rendered from stored rows alone would shrink to five inputs for a
    // Mon–Fri Business, leaving no control to open Saturday with.
    const { hours } = await loadSettings(businessId);

    expect(hours).toHaveLength(7);
    expect(hours.map((row) => row.weekday)).toEqual(
      WEEKDAYS.map((day) => day.weekday),
    );
    expect(hours.map((row) => row.label)).toEqual(WEEKDAYS.map((day) => day.label));
  });

  it("marks a weekday with no row closed, with times to open it at", async () => {
    await makeHours(businessId, 1, "10:00", "19:00");

    const { hours } = await loadSettings(businessId);
    const sunday = hours[0];

    expect(sunday.open).toBe(false);
    // Not empty strings: toggling a day open must not also require typing two
    // times before the form can be submitted.
    expect(sunday.opensAt).toBe("09:00");
    expect(sunday.closesAt).toBe("17:00");
  });

  it("drops the seconds Postgres renders on a `time` column", async () => {
    /*
      `pg` hands back `HH:MM:SS` while an `<input type="time">` speaks `HH:mm`.
      Without normalising, a round trip through the database changes the string
      without changing the meaning and every untouched row reads as edited.
    */
    await makeHours(businessId, 3, "09:30", "17:45");

    const { hours } = await loadSettings(businessId);
    const wednesday = hours[3];

    expect(wednesday.open).toBe(true);
    expect(wednesday.opensAt).toBe("09:30");
    expect(wednesday.closesAt).toBe("17:45");
  });

  it("reads only this Business's Business Hours", async () => {
    await makeHours(otherBusinessId, 2, "08:00", "12:00");

    const { hours } = await loadSettings(businessId);

    expect(hours.every((row) => !row.open)).toBe(true);
  });
});

describe("loadSettings services", () => {
  it("orders by name and carries the duration", async () => {
    await makeService(businessId, "Haircut", 45);
    await makeService(businessId, "Blow-dry", 30);
    await makeService(businessId, "Colour", 90);

    const { services } = await loadSettings(businessId);

    expect(services.map((row) => row.name)).toEqual([
      "Blow-dry",
      "Colour",
      "Haircut",
    ]);
    expect(services.map((row) => row.durationMinutes)).toEqual([30, 90, 45]);
  });

  it("counts the Appointments behind each Service", async () => {
    const haircut = await makeService(businessId, "Haircut");
    const colour = await makeService(businessId, "Colour");
    await makeAppointment(businessId, haircut);
    await makeAppointment(businessId, haircut);
    await makeAppointment(businessId, colour);

    const { services } = await loadSettings(businessId);

    expect(
      Object.fromEntries(services.map((row) => [row.name, row.appointmentCount])),
    ).toEqual({ Colour: 1, Haircut: 2 });
  });

  it("keeps a Service nothing references, and counts it as zero", async () => {
    /*
      The two bugs this pins at once. An `innerJoin` would drop this row
      entirely — hiding exactly the Services that are safe to delete — and a
      star `count()` over the LEFT JOIN would count the synthesised all-null row
      and report 1.
    */
    await makeService(businessId, "Haircut");

    const { services } = await loadSettings(businessId);

    expect(services).toHaveLength(1);
    expect(services[0].appointmentCount).toBe(0);
  });

  it("reads only this Business's Services", async () => {
    await makeService(businessId, "Haircut");
    await makeService(otherBusinessId, "Colour");

    const { services } = await loadSettings(businessId);

    expect(services.map((row) => row.name)).toEqual(["Haircut"]);
  });

  it("returns an empty list rather than failing for a Business with none", async () => {
    const { services } = await loadSettings(businessId);

    expect(services).toEqual([]);
  });

  it("returns nothing but the columns the form renders", async () => {
    // This crosses to the client; `services.created_at` and `business_id` have
    // no business being on the wire.
    const serviceId = await makeService(businessId, "Haircut", 45);

    const { services } = await loadSettings(businessId);

    expect(services).toEqual([
      { id: serviceId, name: "Haircut", durationMinutes: 45, appointmentCount: 0 },
    ]);
  });

  it("counts an Appointment that references the Service from another Business", async () => {
    /*
      Nothing forces `appointments.business_id` to agree with its Service's, and
      the FK that blocks a delete does not look at it. This count therefore has
      to agree with `deleteService`'s, or Settings would offer a delete that the
      guard then refuses.
    */
    const haircut = await makeService(businessId, "Haircut");
    await makeAppointment(otherBusinessId, haircut);

    const { services } = await loadSettings(businessId);

    expect(services[0].appointmentCount).toBe(1);
  });
});

describe("loadSettings", () => {
  it("reads hours and services in one call", async () => {
    await makeHours(businessId, 5, "09:00", "17:00");
    await makeService(businessId, "Haircut");

    const settings = await loadSettings(businessId);

    expect(Object.keys(settings).sort()).toEqual(["hours", "services"]);
    expect(settings.hours[5].open).toBe(true);
    expect(settings.services).toHaveLength(1);
  });

  it("survives a Business id that is not a uuid", async () => {
    // Only reachable from a session-resolved id today, but the failure mode is
    // a thrown `invalid input syntax for type uuid`, not an empty screen.
    await expect(loadSettings("not-a-uuid")).rejects.toThrow();
  });

  it("returns the empty-but-usable shape for a Business with nothing stored", async () => {
    const { hours, services } = await loadSettings(businessId);

    expect(hours).toHaveLength(7);
    expect(services).toEqual([]);
  });
});

describe("loadSettings across both Businesses", () => {
  it("gives each Business its own answer", async () => {
    await makeHours(businessId, 1, "10:00", "19:00");
    await makeHours(otherBusinessId, 6, "08:00", "12:00");
    await makeService(businessId, "Haircut");
    await makeService(otherBusinessId, "Deep clean");

    const [mine, theirs] = await Promise.all([
      loadSettings(businessId),
      loadSettings(otherBusinessId),
    ]);

    expect(mine.hours.filter((row) => row.open).map((row) => row.weekday)).toEqual([
      1,
    ]);
    expect(theirs.hours.filter((row) => row.open).map((row) => row.weekday)).toEqual(
      [6],
    );
    expect(mine.services.map((row) => row.name)).toEqual(["Haircut"]);
    expect(theirs.services.map((row) => row.name)).toEqual(["Deep clean"]);
  });
});

describe("loadSettings placeholders", () => {
  it("uses the stored times for open days and placeholders only for closed ones", async () => {
    await makeHours(businessId, 2, "11:00", "20:00");

    const { hours } = await loadSettings(businessId);

    for (const row of hours) {
      if (row.weekday === 2) {
        expect(row.opensAt).toBe("11:00");
        expect(row.closesAt).toBe("20:00");
      } else {
        expect(row.opensAt).toBe("09:00");
        expect(row.closesAt).toBe("17:00");
      }
    }
  });

  it("never returns a time the form cannot render", async () => {
    await makeHours(businessId, 4, "09:00", "17:00");

    const { hours } = await loadSettings(businessId);

    for (const row of hours) {
      expect(row.opensAt).toMatch(/^\d{2}:\d{2}$/);
      expect(row.closesAt).toMatch(/^\d{2}:\d{2}$/);
    }
  });
});

describe("loadSettings for a Business that does not exist", () => {
  it("answers with an empty week rather than throwing", async () => {
    // A Settings page is a read; there is no row to be denied, and the caller
    // has already resolved the id from the session.
    const { hours, services } = await loadSettings(
      "00000000-0000-4000-8000-000000000000",
    );

    expect(hours).toHaveLength(7);
    expect(services).toEqual([]);
  });
});

describe("loadSettings hours are wall clock", () => {
  it("does not shift a stored time by the Business timezone", async () => {
    // SPEC.md §5: Business Hours are local wall-clock times resolved against
    // `businesses.timezone`, never absolute timestamps. 09:00 in a UTC+05:30
    // Business must come back as 09:00.
    await makeHours(businessId, 0, "09:00", "17:00");

    const { hours } = await loadSettings(businessId);

    expect(hours[0].opensAt).toBe("09:00");
  });
});
