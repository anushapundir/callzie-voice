import { asc, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/**
 * The Services the quick-add card offers in its picker.
 *
 * Separate from `lib/settings/load-settings.ts`, which returns the same rows
 * plus an `appointmentCount` per Service — a count Settings needs to explain why
 * a Service cannot be deleted, and an extra query per Service that Overview
 * would pay for and never render.
 */

export type ServiceOption = {
  id: string;
  name: string;
  durationMinutes: number;
};

export async function listServices(
  businessId: string,
): Promise<ServiceOption[]> {
  return db
    .select({
      id: schema.services.id,
      name: schema.services.name,
      durationMinutes: schema.services.durationMinutes,
    })
    .from(schema.services)
    .where(eq(schema.services.businessId, businessId))
    // Stable order, so the picker's first Service — the one whose Slots the
    // page pre-loads — does not change between renders.
    .orderBy(asc(schema.services.createdAt), asc(schema.services.id));
}
