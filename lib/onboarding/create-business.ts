import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type { OnboardingInput } from "@/lib/onboarding/input";
import { planSeedAppointments } from "@/lib/onboarding/seed-schedule";
import { templateFor } from "@/lib/onboarding/templates";

/** A Callzie Business — the `businesses` row (SPEC.md §5). */
export type Business = typeof schema.businesses.$inferSelect;

export type CreateOnboardedBusinessInput = OnboardingInput & { userId: string };

/**
 * Writes the Business and everything its Template seeds, in one transaction.
 *
 * All four tables move together on purpose. A Business with Business Hours but
 * no Services is the "unusable state" #5 exists to prevent, and a Template bug
 * — an overlapping pair of seeded Appointments hitting `appointments_no_overlap`
 * — must roll the whole thing back rather than strand an account half-onboarded
 * with no way to retry.
 *
 * `now` is injected so seeded times are deterministic under test.
 */
export async function createOnboardedBusiness(
  input: CreateOnboardedBusinessInput,
  now: Date = new Date(),
): Promise<{ business: Business; created: boolean }> {
  const template = templateFor(input.businessType);

  return db.transaction(async (tx) => {
    /*
      Idempotency comes from the `businesses_user_id_unique` index, not from an
      application check — the same lever `provisionUser` uses on `clerk_id`.
      A double-submit or two racing tabs both reach here; Postgres blocks the
      loser on the index until the winner commits, then returns it zero rows.
      There is no window between a read and a write to lose.

      DO NOTHING rather than DO UPDATE: DO UPDATE would let a second submit
      silently rewrite an existing Business's name, type and timezone, and would
      then need the seed de-duplicated on top. "Exactly one Business per
      account, first write wins" is what the acceptance criterion asks for.
    */
    const [created] = await tx
      .insert(schema.businesses)
      .values({
        userId: input.userId,
        name: input.name,
        businessType: input.businessType,
        timezone: input.timezone,
      })
      .onConflictDoNothing({ target: schema.businesses.userId })
      .returning();

    if (!created) {
      const existing = await tx.query.businesses.findFirst({
        where: eq(schema.businesses.userId, input.userId),
      });
      if (!existing) {
        // The insert conflicted, so a row for this user exists. Not finding it
        // means the conflict came from a different constraint entirely.
        throw new Error(
          `businesses insert conflicted for user ${input.userId} but no row was found`,
        );
      }
      // Already onboarded — return the Business without seeding it a second
      // time. A second seed would collide with `appointments_no_overlap`.
      return { business: existing, created: false };
    }

    await tx.insert(schema.businessHours).values(
      template.hours.map((hours) => ({
        businessId: created.id,
        weekday: hours.weekday,
        opensAt: hours.opensAt,
        closesAt: hours.closesAt,
      })),
    );

    const services = await tx
      .insert(schema.services)
      .values(
        template.services.map((service) => ({
          businessId: created.id,
          name: service.name,
          durationMinutes: service.durationMinutes,
        })),
      )
      .returning({ id: schema.services.id, name: schema.services.name });

    const serviceIdByName = new Map(services.map((s) => [s.name, s.id]));

    await tx.insert(schema.appointments).values(
      planSeedAppointments(template, input.timezone, now).map((appointment) => {
        const serviceId = serviceIdByName.get(appointment.serviceName);
        if (!serviceId) {
          // `templates.test.ts` asserts every seeded Appointment names a
          // Service the Template offers, so this is unreachable by design.
          throw new Error(
            `Seeded Appointment "${appointment.name}" names Service ` +
              `"${appointment.serviceName}", which was not inserted`,
          );
        }
        return {
          businessId: created.id,
          serviceId,
          name: appointment.name,
          phoneE164: appointment.phoneE164,
          startsAt: appointment.startsAt,
          endsAt: appointment.endsAt,
          status: appointment.status,
        };
      }),
    );

    return { business: created, created: true };
  });
}
