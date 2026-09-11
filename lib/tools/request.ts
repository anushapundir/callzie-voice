import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";

/**
 * Who a Tool call is about — resolved from the `call` object Retell sends, never
 * from anything the model wrote.
 *
 * `lib/retell/tools.ts` refuses to put an identifier in any Tool's argument
 * schema and gives the reason: if the Appointment id were an argument, the model
 * would be choosing which row it writes to, and one hallucinated uuid becomes a
 * cross-tenant write. This module is the other half of that promise. Everything
 * downstream is scoped by the `businessId` that comes out of here.
 *
 * The chain, all from one string:
 *
 *   call.call_id -> calls.retell_call_id -> calls.appointment_id
 *                -> appointments -> businesses.timezone, services.duration_minutes
 */

/** What Retell posts (docs/verification.md A12). Only the fields Callzie reads. */
export type ToolRequestBody = {
  name: string;
  /** `call.call_id` — Retell's id, not the `calls.id` primary key. */
  callId: string;
  args: Record<string, unknown>;
};

export type ToolContext = {
  /** `calls.id`. This is what a `tool_invocations` row points at. */
  callId: string;
  appointment: typeof schema.appointments.$inferSelect;
  businessId: string;
  /** IANA zone. Everything Maya says aloud is rendered in it. */
  timezone: string;
  serviceId: string;
  /** The Service's length, which is also the Slot size. */
  durationMinutes: number;
};

/**
 * Who an *inbound* Tool call is about (issue #43).
 *
 * The same promise as `ToolContext` above, resolved down a different chain. An
 * inbound Call has no Appointment, so there is nothing to resolve one from —
 * the tenant comes off the Call itself:
 *
 *   call.call_id -> calls.retell_call_id -> calls.business_id -> businesses
 *
 * `businessId` still never comes from an argument. That is the entire point of
 * both of these modules: `lib/retell/tools.ts` refuses to put an identifier in
 * any Tool's schema, so one hallucinated uuid cannot become a cross-tenant
 * write. An inbound Call talks to a stranger, which makes the rule matter more
 * here, not less.
 *
 * Note what is absent: `serviceId` and `durationMinutes`. An inbound caller has
 * not said what they want yet, so the Service is an argument the handler
 * resolves per call — see `lib/tools/service-choice.ts`.
 */
export type InboundToolContext = {
  callId: string;
  businessId: string;
  timezone: string;
  /**
   * The number the caller is ringing from, or null on the web widget.
   *
   * A phone caller always has one — `decideInbound` refuses a withheld caller
   * ID before the Call is connected. A widget visitor never does, and that is
   * not a degraded case but a different one: they are a stranger on a web page,
   * and the only number Callzie can ever have for them is one they say out loud.
   *
   * Two Tools care. `lookup_appointment` matches on it and returns nothing when
   * it is null — which is correct, because there is nothing to match. And
   * `log_enquiry` falls back to it for a callback number, so a widget Enquiry
   * keeps whatever the caller gave and nothing otherwise.
   */
  fromNumber: string | null;
};

/**
 * Reads Retell's envelope, or returns null.
 *
 * Null rather than a thrown error: the caller turns it into a 400, and a
 * malformed body is an ordinary thing to receive on a URL reachable from the
 * internet, not an exceptional one.
 */
export function parseToolRequest(body: unknown): ToolRequestBody | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;

  const { name, call, args } = body as {
    name?: unknown;
    call?: unknown;
    args?: unknown;
  };

  if (typeof name !== "string" || name === "") return null;
  if (typeof call !== "object" || call === null) return null;

  const callId = (call as { call_id?: unknown }).call_id;
  if (typeof callId !== "string" || callId === "") return null;

  /*
    A Tool with an empty parameter schema — confirm_appointment and
    cancel_appointment — may arrive with no `args` key at all. That is a valid
    call with no arguments, not a malformed body, so it becomes {} rather than a
    400.

    The array check is not redundant: `typeof [] === "object"`, so without it a
    JSON array would be accepted as an arguments object and land in the
    `tool_invocations.arguments` column as something no reader expects.
  */
  const suppliedArgs = args ?? {};
  if (typeof suppliedArgs !== "object" || Array.isArray(suppliedArgs)) return null;

  return { name, callId, args: suppliedArgs as Record<string, unknown> };
}

/** Everything the four handlers need, or null if this Call is unknown. */
export async function resolveToolContext(
  retellCallId: string,
): Promise<ToolContext | null> {
  const call = await db.query.calls.findFirst({
    where: eq(schema.calls.retellCallId, retellCallId),
    columns: { id: true, appointmentId: true },
  });
  if (!call) return null;

  /*
    An inbound Call has no Appointment (issue #43), and the four Tools this
    resolves for all act on one. Returning null here makes the route answer 404
    — "unknown call" — which is the honest answer: this Call is not one these
    Tools can act on.

    It should also be unreachable. An inbound Agent is created with the inbound
    Tool set and never holds `book_slot` at all (lib/retell/tools.ts). This is
    the second lock on that door, because the first one is configuration held in
    Retell's dashboard and this one is not.
  */
  if (call.appointmentId === null) return null;

  const appointment = await db.query.appointments.findFirst({
    where: eq(schema.appointments.id, call.appointmentId),
  });
  if (!appointment) return null;

  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.id, appointment.businessId),
    columns: { id: true, timezone: true },
  });
  if (!business) return null;

  const service = await db.query.services.findFirst({
    // Scoped to the Business, matching lib/availability/schedule.ts: a Service
    // from another account must not resolve, or one Business could have its
    // Slots sized by another's duration.
    where: and(
      eq(schema.services.id, appointment.serviceId),
      eq(schema.services.businessId, appointment.businessId),
    ),
    columns: { id: true, durationMinutes: true },
  });
  if (!service) return null;

  return {
    callId: call.id,
    appointment,
    businessId: business.id,
    timezone: business.timezone,
    serviceId: service.id,
    durationMinutes: service.durationMinutes,
  };
}

/**
 * Everything the three inbound handlers need, or null if this Call is unknown.
 *
 * Refuses an outbound Call as firmly as `resolveToolContext` refuses an inbound
 * one. The two are not interchangeable: running `log_enquiry` against a
 * confirmation call would write an Enquiry about an Appointment Callzie itself
 * rang up, and `book_appointment` would create a second Appointment for somebody
 * who already has one.
 *
 * Like its outbound twin this should also be unreachable — the two Agents carry
 * different Tool sets — but the Tool set is configuration held in Retell, and
 * this is not.
 */
export async function resolveInboundToolContext(
  retellCallId: string,
): Promise<InboundToolContext | null> {
  const call = await db.query.calls.findFirst({
    where: eq(schema.calls.retellCallId, retellCallId),
    columns: {
      id: true,
      businessId: true,
      direction: true,
      fromNumber: true,
    },
  });
  if (!call) return null;
  if (call.direction !== "inbound") return null;

  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.id, call.businessId),
    columns: { id: true, timezone: true },
  });
  if (!business) return null;

  return {
    callId: call.id,
    businessId: business.id,
    timezone: business.timezone,
    fromNumber: call.fromNumber,
  };
}
