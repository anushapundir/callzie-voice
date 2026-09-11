import { and, asc, eq } from "drizzle-orm";

import { callOutcome, type CallOutcome, type InvocationRow } from "@/lib/calls/outcome";
import { callTranscript, type TranscriptTurn } from "@/lib/calls/transcript";
import { db, schema } from "@/lib/db";
import type {
  CallDirection,
  CallStatus,
  CallType,
  EnquiryKind,
  ExtractionStatus,
  Sentiment,
} from "@/lib/db/schema";

/*
  Everything the Call detail screen reads, in one place.

  The house pattern, the same one `lib/schedule/load-day.ts` follows: one
  server-side loader that returns a plain object, and components that render it
  without thinking. The alternative — each card running its own query — costs
  five round trips and leaves every derivation untestable without mounting a
  component.

  **Scoped through `appointments` to the Business inside the WHERE clause**, the
  way `lib/business/active-calls.ts` does it. `callId` arrives from the URL and
  Callzie is open signup, so a loader that read across accounts would put one
  Business's transcript on another's screen. A miss returns null and the page
  calls `notFound()` — not a 403, which would confirm the id exists.
*/

export type CallExtraction = {
  notes: string | null;
  summary: string | null;
  sentiment: Sentiment | null;
  inVoicemail: boolean | null;
  confirmed: boolean | null;
  newTime: string | null;
  status: ExtractionStatus;
  rawLlmOutput: string | null;
};

/** What an inbound Call turned out to be. Null on every outbound Call. */
export type CallEnquiry = {
  kind: EnquiryKind;
  topic: string | null;
  callerName: string | null;
  callerPhoneE164: string | null;
  resolved: boolean;
  appointmentId: string | null;
};

export type CallDetail = {
  id: string;
  direction: CallDirection;
  /**
   * Null on an inbound Call that did not book (issue #43).
   *
   * An inbound Call starts with no Appointment and may never get one — somebody
   * ringing to ask what time you close is a Call about nothing that is booked.
   * Every field below that describes an Appointment is nullable for the same
   * reason, and the screen renders the Enquiry instead.
   */
  appointmentId: string | null;
  /**
   * Who Maya was talking to.
   *
   * Never null, because the transcript has to label its turns with something.
   * For an outbound Call it is the Appointment's name; for an inbound one it is
   * whatever the caller gave, falling back to a description of the number.
   */
  personName: string;
  /** The Appointment's number outbound; the caller's number inbound. */
  phoneE164: string;
  serviceName: string | null;
  appointmentStartsAt: Date | null;
  timezone: string;
  callType: CallType;
  status: CallStatus;
  attempt: number;
  /** How many Calls this Appointment has had, for "Attempt 2 of 2". */
  attemptCount: number;
  durationSeconds: number | null;
  recordingUrl: string | null;
  disconnectReason: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  turns: TranscriptTurn[];
  /** True when a transcript exists in either column — the waiting panel's condition. */
  hasTranscript: boolean;
  outcome: CallOutcome;
  extraction: CallExtraction | null;
  enquiry: CallEnquiry | null;
};

export async function loadCallDetail(
  businessId: string,
  callId: string,
): Promise<CallDetail | null> {
  const [row] = await db
    .select({
      id: schema.calls.id,
      appointmentId: schema.appointments.id,
      direction: schema.calls.direction,
      fromNumber: schema.calls.fromNumber,
      callType: schema.calls.callType,
      status: schema.calls.status,
      attempt: schema.calls.attempt,
      durationSeconds: schema.calls.durationSeconds,
      recordingUrl: schema.calls.recordingUrl,
      transcript: schema.calls.transcript,
      transcriptTurns: schema.calls.transcriptTurns,
      disconnectReason: schema.calls.disconnectReason,
      startedAt: schema.calls.startedAt,
      endedAt: schema.calls.endedAt,
      personName: schema.appointments.name,
      phoneE164: schema.appointments.phoneE164,
      appointmentStartsAt: schema.appointments.startsAt,
      serviceName: schema.services.name,
      timezone: schema.businesses.timezone,
    })
    .from(schema.calls)
    /*
      LEFT since issue #43, and scoped by `calls.business_id` rather than by
      the Appointment's.

      Both changes are the same change: an inbound Call has no Appointment, so
      an inner join would drop it and a tenant check that reads
      `appointments.business_id` would have nothing to read. The Call now
      carries its own Business, which is what makes an inbound Call findable at
      all — and the scoping is just as tight, because `calls.business_id` is
      NOT NULL.
    */
    .leftJoin(
      schema.appointments,
      eq(schema.calls.appointmentId, schema.appointments.id),
    )
    .leftJoin(schema.services, eq(schema.appointments.serviceId, schema.services.id))
    .innerJoin(
      schema.businesses,
      eq(schema.calls.businessId, schema.businesses.id),
    )
    .where(and(eq(schema.calls.id, callId), eq(schema.calls.businessId, businessId)));

  /*
    Not found, or found and belonging to somebody else. This function cannot
    tell the two apart, which is the point — a 403 would confirm the id exists.
  */
  if (!row) return null;

  const [invocations, extraction, enquiry, siblings] = await Promise.all([
    db
      .select({
        id: schema.toolInvocations.id,
        toolName: schema.toolInvocations.toolName,
        arguments: schema.toolInvocations.arguments,
        result: schema.toolInvocations.result,
        succeeded: schema.toolInvocations.succeeded,
        latencyMs: schema.toolInvocations.latencyMs,
        createdAt: schema.toolInvocations.createdAt,
      })
      .from(schema.toolInvocations)
      .where(eq(schema.toolInvocations.callId, callId))
      .orderBy(asc(schema.toolInvocations.createdAt)),
    db.query.extractions.findFirst({
      where: eq(schema.extractions.callId, callId),
    }),
    db.query.enquiries.findFirst({
      where: eq(schema.enquiries.callId, callId),
    }),
    /*
      "Attempt 2 of 2" counts Calls against one Appointment, which an inbound
      Call does not have. An empty list rather than a query, so the header
      renders "1 of 1" — an inbound Call is always its own only attempt, because
      nobody re-dials somebody who rang them.
    */
    row.appointmentId
      ? db
          .select({ id: schema.calls.id })
          .from(schema.calls)
          .where(eq(schema.calls.appointmentId, row.appointmentId))
      : Promise.resolve([{ id: row.id }]),
  ]);

  const turns = callTranscript({
    transcriptTurns: row.transcriptTurns,
    transcript: row.transcript,
  });

  return {
    id: row.id,
    direction: row.direction,
    appointmentId: row.appointmentId,
    /*
      The transcript has to label its turns with something, so this is never
      null. Outbound it is the Appointment's name. Inbound it is whatever the
      caller gave — which they may never have — and then the number they rang
      from, which is at least true and at least identifies them.
    */
    personName:
      row.personName ?? enquiry?.callerName ?? callerLabel(row.fromNumber),
    phoneE164: row.phoneE164 ?? row.fromNumber ?? "",
    serviceName: row.serviceName,
    appointmentStartsAt: row.appointmentStartsAt,
    timezone: row.timezone,
    callType: row.callType,
    status: row.status,
    attempt: row.attempt,
    attemptCount: siblings.length,
    durationSeconds: row.durationSeconds,
    recordingUrl: row.recordingUrl,
    disconnectReason: row.disconnectReason,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    turns,
    hasTranscript: turns.length > 0,
    /*
      `createdAt` is nullable in the schema — it has a database default, which
      Drizzle cannot promise TypeScript was applied. The Call happened, so the
      row has a time; the epoch fallback keeps the sort total without pretending
      otherwise.
    */
    outcome: callOutcome(
      invocations.map(
        (invocation): InvocationRow => ({
          ...invocation,
          createdAt: invocation.createdAt ?? new Date(0),
        }),
      ),
    ),
    extraction: extraction
      ? {
          notes: extraction.notes,
          summary: extraction.summary,
          sentiment: extraction.sentiment,
          inVoicemail: extraction.inVoicemail,
          confirmed: extraction.confirmed,
          newTime: extraction.newTime,
          status: extraction.status,
          rawLlmOutput: extraction.rawLlmOutput,
        }
      : null,
    enquiry: enquiry
      ? {
          kind: enquiry.kind,
          topic: enquiry.topic,
          callerName: enquiry.callerName,
          callerPhoneE164: enquiry.callerPhoneE164,
          resolved: enquiry.resolved,
          appointmentId: enquiry.appointmentId,
        }
      : null,
  };
}

/**
 * What to call somebody who did not give a name.
 *
 * The number itself, because it is the only true thing available and it is what
 * somebody at the business would use to ring them back. "Unknown caller" only
 * when even that is missing, which `decideInbound` makes very unlikely — it
 * refuses a withheld caller ID before the Call is ever connected.
 */
function callerLabel(fromNumber: string | null): string {
  return fromNumber ? `Caller ${fromNumber}` : "Unknown caller";
}
