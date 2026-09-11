/*
  Manual QA helper for issue #6. Prints the Availability the engine computes for
  a real Business, so you can eyeball it against that Business's Settings.

  Run it with the Cloud SQL Auth Proxy up (so DATABASE_URL points at your real
  database):

    npx tsx <path-to-this-file>            # next 7 days, every Service
    npx tsx <path-to-this-file> 14         # next 14 days

  It only reads. It writes nothing.
*/

import { findAvailableSlots } from "@/lib/availability/find";
import { db, schema } from "@/lib/db";
import { formatInZone } from "@/lib/time/zone";
import { toWallTime } from "@/lib/settings/weekdays";
import { WEEKDAYS } from "@/lib/settings/weekdays";
import { eq, asc } from "drizzle-orm";

export async function report(days: number) {
  const businesses = await db.select().from(schema.businesses);
  if (businesses.length === 0) {
    console.log("No Business rows. Sign up and complete Onboarding first.");
    return;
  }

  const now = new Date();
  const to = new Date(now.getTime() + days * 86_400_000);

  for (const business of businesses) {
    console.log("=".repeat(72));
    console.log(`${business.name}  [${business.businessType}]`);
    console.log(`timezone: ${business.timezone}`);
    console.log(`now there: ${formatInZone(now, business.timezone)}`);
    console.log("=".repeat(72));

    const hours = await db
      .select()
      .from(schema.businessHours)
      .where(eq(schema.businessHours.businessId, business.id))
      .orderBy(asc(schema.businessHours.weekday));

    console.log("\nBusiness Hours");
    if (hours.length === 0) console.log("  (none set — expect zero Slots)");
    for (const h of hours) {
      const label = WEEKDAYS[h.weekday]?.label ?? `Day ${h.weekday}`;
      console.log(
        `  ${label.padEnd(10)} ${toWallTime(h.opensAt)}-${toWallTime(h.closesAt)}`,
      );
    }

    const appointments = await db
      .select()
      .from(schema.appointments)
      .where(eq(schema.appointments.businessId, business.id))
      .orderBy(asc(schema.appointments.startsAt));

    console.log("\nAppointments already held");
    if (appointments.length === 0) console.log("  (none)");
    for (const a of appointments) {
      const held = !["declined", "cancelled"].includes(a.status);
      console.log(
        `  ${formatInZone(a.startsAt, business.timezone)}  ` +
          `${a.name.padEnd(18)} ${a.status.padEnd(12)} ` +
          `${held ? "HOLDS its Slot" : "frees its Slot"}`,
      );
    }

    const services = await db
      .select()
      .from(schema.services)
      .where(eq(schema.services.businessId, business.id));

    for (const service of services) {
      const slots = await findAvailableSlots({
        businessId: business.id,
        serviceId: service.id,
        from: now,
        to,
        now,
      });

      console.log(
        `\n--- ${service.name} (${service.durationMinutes} min) — ` +
          `${slots.length} open Slots in the next ${days} days ---`,
      );

      // Group by local day so it reads like a calendar.
      const byDay = new Map<string, string[]>();
      for (const slot of slots) {
        const full = formatInZone(slot.startsAt, business.timezone);
        // "Tue 12 Aug, 14:30" -> day "Tue 12 Aug", time "14:30"
        const [day, time] = full.split(", ");
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day)!.push(time);
      }

      if (byDay.size === 0) console.log("  (none)");
      for (const [day, times] of byDay) {
        console.log(`  ${day.padEnd(14)} ${times.join("  ")}`);
      }
    }
    console.log();
  }
}

// Only run when invoked directly, so the report can also be imported.
if (process.argv[1]?.endsWith("show-availability.ts")) {
  report(Number(process.argv[2]) || 7)
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
