import { desc, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type { CallStatus } from "@/lib/db/schema";

/*
  Every Call this Business has placed, newest first.

  Deliberately small. This screen exists so the sidebar's Calls link is not a
  dead end and so there is a way into the proof screen that does not go through
  the Overview table — filters, sorting and pagination are a later ticket if
  they are ever one.

  Scoped through `appointments` inside the WHERE clause, like every other
  cross-table read in this app.
*/

export type CallListRow = {
  id: string;
  personName: string;
  serviceName: string;
  appointmentStartsAt: Date;
  timezone: string;
  status: CallStatus;
  attempt: number;
  durationSeconds: number | null;
  createdAt: Date | null;
};

export async function listCalls(businessId: string): Promise<CallListRow[]> {
  return db
    .select({
      id: schema.calls.id,
      personName: schema.appointments.name,
      serviceName: schema.services.name,
      appointmentStartsAt: schema.appointments.startsAt,
      timezone: schema.businesses.timezone,
      status: schema.calls.status,
      attempt: schema.calls.attempt,
      durationSeconds: schema.calls.durationSeconds,
      createdAt: schema.calls.createdAt,
    })
    .from(schema.calls)
    .innerJoin(
      schema.appointments,
      eq(schema.calls.appointmentId, schema.appointments.id),
    )
    .innerJoin(schema.services, eq(schema.appointments.serviceId, schema.services.id))
    .innerJoin(
      schema.businesses,
      eq(schema.appointments.businessId, schema.businesses.id),
    )
    .where(eq(schema.appointments.businessId, businessId))
    .orderBy(desc(schema.calls.createdAt));
}
