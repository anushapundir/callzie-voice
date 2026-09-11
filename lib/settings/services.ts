import { and, count, eq, ne, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type { ServiceErrors, ServiceInput } from "@/lib/settings/services-input";

/**
 * Adding, editing and removing the Services a Business offers (issue #5).
 *
 * `lib/settings/services-input.ts` decides whether the *submitted values* are
 * well formed. This module decides whether the *change* is allowed, which is a
 * question only the database can answer: who owns the row, whether the name is
 * already taken, and what still points at a Service somebody wants gone.
 *
 * Two rules run through every function here.
 *
 * **Every query is scoped by `businessId`.** A Server Action is a POST endpoint
 * reachable by anyone who can send it
 * (`node_modules/next/dist/docs/01-app/02-guides/server-actions.md`,
 * "Security"), so the `serviceId` arriving in the FormData is untrusted input
 * that happens to look like a uuid. The Business id is not — it is resolved
 * from the Clerk session by the caller. A `WHERE id = $1` without
 * `AND business_id = $2` would let anyone who guesses or harvests a uuid edit
 * another account's Services.
 *
 * **Explicit `select` + `where`, never `db.query.x.findMany({ with })`.** No
 * `relations()` are declared anywhere in this repo — `lib/db/schema.ts` wires
 * tables together with FK `.references()` only, and the relational query API
 * needs more than that. See `lib/business/list-appointments.ts`.
 */

export type ServiceMutation = { ok: true } | { ok: false; errors: ServiceErrors };

/**
 * One message for "there is no such Service" and for "that Service belongs to
 * somebody else".
 *
 * Deliberately identical. A distinguishable pair — "not found" versus
 * "forbidden" — turns this endpoint into an oracle that confirms whether a
 * given uuid names a real row in another Business's Services. There is nothing
 * a legitimate caller can do with the difference, because a legitimate caller
 * only ever submits ids from its own rendered list.
 */
const MISSING = "That service no longer exists.";

/**
 * A malformed id has to be survivable, not just a wrong one. `services.id` is
 * `uuid`, and Postgres answers a comparison against a string that is not one
 * with `invalid input syntax for type uuid` — a thrown error, not zero rows.
 * Anyone can post `id=drop-me`, so without this that is an unhandled 500 on
 * demand.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function failure(errors: ServiceErrors): ServiceMutation {
  return { ok: false, errors };
}

/**
 * The id of a Service of this Business already using `name`, ignoring case.
 *
 * `lower(name) = lower($1)` rather than `ilike(services.name, name)`: `ilike`
 * reads `%` and `_` in its pattern as wildcards, so a Business with a Service
 * called "Cut _ Colour" would find "Cut & Colour" a duplicate of it. The
 * comparison wanted here is equality that ignores case, not a match.
 *
 * There is no unique index behind this — enforcing it in Postgres would mean a
 * `UNIQUE (business_id, lower(name))` migration, a schema-wide change rather
 * than a feature ticket's. Two simultaneous submits can therefore both pass;
 * the consequence is bounded to a confusing list, because the one place that
 * resolves a Service *by name* is `lib/onboarding/create-business.ts`, and that
 * runs once, from a Template whose names are unique, before Settings can be
 * reached at all.
 */
async function findConflictingName(
  businessId: string,
  name: string,
  excludeServiceId?: string,
): Promise<string | undefined> {
  const [conflict] = await db
    .select({ id: schema.services.id })
    .from(schema.services)
    .where(
      and(
        eq(schema.services.businessId, businessId),
        sql`lower(${schema.services.name}) = lower(${name})`,
        excludeServiceId ? ne(schema.services.id, excludeServiceId) : undefined,
      ),
    )
    .limit(1);

  return conflict?.id;
}

/** Renaming a Service to a name a sibling already holds is refused. */
const NAME_TAKEN = "You already offer a service with that name.";

export async function addService(
  businessId: string,
  input: ServiceInput,
): Promise<ServiceMutation> {
  if (await findConflictingName(businessId, input.name)) {
    return failure({ name: NAME_TAKEN });
  }

  await db.insert(schema.services).values({
    businessId,
    name: input.name,
    durationMinutes: input.durationMinutes,
  });

  return { ok: true };
}

export async function updateService(
  businessId: string,
  serviceId: string,
  input: ServiceInput,
): Promise<ServiceMutation> {
  /*
    Ownership is settled before anything else is even considered, so an
    untrusted id can never reach a query that would report something about the
    row it names. Doing the duplicate-name check first would answer a bogus id
    with a name error, which is a worse message and starts leaking the shape of
    another account's data.
  */
  if (!(await ownedService(businessId, serviceId))) {
    return failure({ form: MISSING });
  }

  // Excluding the row being edited, or saving a Service without renaming it
  // would collide with itself.
  if (await findConflictingName(businessId, input.name, serviceId)) {
    return failure({ name: NAME_TAKEN });
  }

  await db
    .update(schema.services)
    .set({ name: input.name, durationMinutes: input.durationMinutes })
    .where(
      and(
        eq(schema.services.id, serviceId),
        eq(schema.services.businessId, businessId),
      ),
    );

  /*
    Changing `durationMinutes` deliberately does not rewrite the `ends_at` of
    Appointments already booked against this Service. Those rows record what was
    agreed with a named person on a Call; `ends_at` is derived from the duration
    *at write time* (`lib/db/schema.ts`), and silently stretching a confirmed
    booking could push it into a neighbour and violate `appointments_no_overlap`
    — an edit to a Settings field must not fail on data the person editing it
    cannot see. The new duration applies to everything booked from here on.
  */
  return { ok: true };
}

export async function deleteService(
  businessId: string,
  serviceId: string,
): Promise<ServiceMutation> {
  if (!(await ownedService(businessId, serviceId))) {
    return failure({ form: MISSING });
  }

  /*
    `appointments.service_id` is NOT NULL with ON DELETE no action
    (drizzle/0000_wakeful_tarot.sql), so deleting a referenced Service does not
    cascade and does not null out — Postgres raises a foreign key violation that
    would surface to the user as an unhandled 500 on a Settings form.

    Counted by `service_id` alone, without `AND business_id = $2`. Ownership is
    already established above; what matters now is what the *constraint* sees,
    and the constraint does not know about `business_id`. Nothing in the schema
    forces an Appointment's `business_id` to agree with its Service's, so a
    business-scoped count could come back zero while a row still referenced the
    Service — reintroducing exactly the raw error this check exists to prevent.
  */
  const [referencing] = await db
    .select({ value: count() })
    .from(schema.appointments)
    .where(eq(schema.appointments.serviceId, serviceId));

  const appointmentCount = referencing?.value ?? 0;
  if (appointmentCount > 0) {
    return failure({
      form:
        `${appointmentCount} ${appointmentCount === 1 ? "appointment uses" : "appointments use"} ` +
        `this service, so it cannot be removed.`,
    });
  }

  /*
    A Business with no Services can hold no Appointment — `service_id` is NOT
    NULL, so there is nothing to book. That is the same unusable state issue #5
    exists to prevent as a week with no open days, and it is reachable in two
    clicks from a fresh account. Refused rather than warned about: recovering
    means adding a Service back, which is strictly more work than not deleting
    the last one.
  */
  const [remaining] = await db
    .select({ value: count() })
    .from(schema.services)
    .where(eq(schema.services.businessId, businessId));

  if ((remaining?.value ?? 0) <= 1) {
    return failure({
      form: "Keep at least one service — add another before removing this one.",
    });
  }

  await db
    .delete(schema.services)
    .where(
      and(
        eq(schema.services.id, serviceId),
        eq(schema.services.businessId, businessId),
      ),
    );

  return { ok: true };
}

/** True when `serviceId` names a Service of this Business. */
async function ownedService(
  businessId: string,
  serviceId: string,
): Promise<boolean> {
  if (!UUID.test(serviceId)) return false;

  const [owned] = await db
    .select({ id: schema.services.id })
    .from(schema.services)
    .where(
      and(
        eq(schema.services.id, serviceId),
        eq(schema.services.businessId, businessId),
      ),
    )
    .limit(1);

  return owned !== undefined;
}
