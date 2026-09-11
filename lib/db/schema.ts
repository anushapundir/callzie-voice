import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  time,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import type { StoredTurn } from "@/lib/calls/transcript";

// Schema follows SPEC.md §5. Status columns are plain `text` rather than pg enums
// so a new status never needs a migration; the unions below are the real contract
// and are enforced in application code.
//
// The no-overlap guarantee (SPEC.md §3 rule 8) is an EXCLUDE constraint that
// Drizzle cannot express — it lives as raw SQL in the migration. Do not replace it
// with an application-level check; three concurrent Agents will find any gap
// between a read and a write.

export const BUSINESS_TYPES = [
  "clinic",
  "salon",
  "home_services",
  "tutoring",
] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const APPOINTMENT_STATUSES = [
  "pending",
  /*
    Waiting for a free slot in the Call All throttle (issue #17).

    Note that `calls.status` also has a `queued`, meaning something adjacent but
    different: that a Call row exists and Retell has not been contacted yet.
    Both are "written down, not yet dialled" — one about an Appointment, one
    about a Call.
  */
  "queued",
  "calling",
  "confirmed",
  "rescheduled",
  "declined",
  "cancelled",
  "unreachable",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

// Orthogonal to status, not a value of it — an Appointment can be `confirmed`
// AND collided. Non-null means Callzie will not call this person again until a
// human clears it (SPEC.md §5).
export const NEEDS_ATTENTION_REASONS = [
  "book_failed",
  "collision",
  "negotiation_truncated",
  "unreachable",
] as const;
/*
  Deliberately NOT extended for inbound (issue #43).

  A caller who asks for a callback, or who complains, has no Appointment to flag
  — so there is nothing for a `needs_attention_reason` to hang off. That state
  lives on the Enquiry instead, as `kind` plus `resolved`, which already says
  everything a reason string would.

  The Needs Attention *surface* renders both sources side by side. That is a
  question about one screen, not a reason to make one column mean two things.
*/
export type NeedsAttentionReason = (typeof NEEDS_ATTENTION_REASONS)[number];

/*
  Which Appointments free their Slot, and which hold it.

  These two lists must agree with the WHERE clause of the `appointments_no_overlap`
  EXCLUDE constraint in drizzle/0001_appointments_no_overlap.sql. If they drift,
  Availability starts offering Slots the database will refuse, and Maya reads a
  time aloud that then fails to book — SPEC.md §3 rule 7, the most damaging
  failure available to this product.

  `lib/db/schema.test.ts` parses the migration and asserts the lists still match,
  because a constant alone cannot catch someone editing only the SQL.

  Note what is NOT here: `unreachable`. An unanswered phone is not a
  cancellation, so an unreachable Appointment keeps its Slot and waits for a
  human (SPEC.md §14 rule 2).
*/
export const SLOT_FREEING_STATUSES = ["declined", "cancelled"] as const;

export const SLOT_HOLDING_STATUSES = APPOINTMENT_STATUSES.filter(
  (status): status is Exclude<AppointmentStatus, "declined" | "cancelled"> =>
    !SLOT_FREEING_STATUSES.includes(status as (typeof SLOT_FREEING_STATUSES)[number]),
);

export const CALL_TYPES = ["web", "phone"] as const;
export type CallType = (typeof CALL_TYPES)[number];

export const CALL_STATUSES = [
  "queued",
  "ringing",
  "in_progress",
  "completed",
  "no_answer",
  "failed",
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

/*
  Which way a Call went.

  Not a second value of `call_type` (web | phone): the two are genuinely
  independent. An inbound Call arrives over the browser widget or over the
  telephone, and an outbound one goes out over either, so all four combinations
  are real.
*/
export const CALL_DIRECTIONS = ["outbound", "inbound"] as const;
export type CallDirection = (typeof CALL_DIRECTIONS)[number];

export const TOOL_NAMES = [
  "check_availability",
  "book_slot",
  "confirm_appointment",
  "cancel_appointment",
  // Inbound only (issue #43). `book_appointment` CREATES an Appointment;
  // `book_slot` above MOVES one. They are deliberately separate Tools — see
  // lib/retell/tools.ts for why widening book_slot would have broken the index
  // that caps Reschedules.
  "book_appointment",
  "lookup_appointment",
  "log_enquiry",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * The Tools an inbound Call may invoke.
 *
 * The split is a security boundary, not a convenience. An outbound Tool resolves
 * its Appointment from the Call; an inbound one has no Appointment to resolve
 * and works from the Business instead. Handing an inbound Call a `book_slot`
 * would mean a Tool looking for an Appointment that is not there, and handing an
 * outbound Call a `book_appointment` would let a confirmation call create rows.
 */
export const INBOUND_TOOL_NAMES = [
  "check_availability",
  "book_appointment",
  "lookup_appointment",
  "log_enquiry",
] as const;

export const OUTBOUND_TOOL_NAMES = [
  "check_availability",
  "book_slot",
  "confirm_appointment",
  "cancel_appointment",
] as const;

/*
  What an inbound Call turned out to be.

  `refused` is not a failure — it is Maya correctly declining to help, which is
  the outcome SPEC.md §14 rules 10 to 13 are written to produce. It is recorded
  precisely so that "she refused" is visible rather than looking like a Call
  where nothing happened.
*/
export const ENQUIRY_KINDS = [
  "booked",
  "question",
  "complaint",
  "callback",
  "refused",
] as const;
export type EnquiryKind = (typeof ENQUIRY_KINDS)[number];

export const EXTRACTION_STATUSES = ["ok", "failed"] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

// SPEC.md §9 step 2 fixes these three. Plain `text` in the table like every
// other status column; this union is the contract application code enforces,
// and lib/extraction/parse.ts rejects an answer outside it.
export const SENTIMENTS = ["positive", "neutral", "negative"] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  clerkId: text("clerk_id").notNull().unique(),
  email: text("email"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const businesses = pgTable("businesses", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Unique: exactly one Business per account. No orgs, no invites, no roles
  // (SPEC.md §14 rule 9).
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id),
  name: text("name").notNull(),
  businessType: text("business_type").$type<BusinessType>().notNull(),
  // IANA zone. Business Hours are stored as local wall-clock times and resolved
  // against this — never as absolute timestamps.
  timezone: text("timezone").notNull(),
  callQuota: integer("call_quota").notNull().default(5),
  callsUsed: integer("calls_used").notNull().default(0),
  // SPEC.md §3 rule 9. Open signup plus arbitrary outbound dialling is a
  // robocalling tool; signups get Web Calls only.
  phoneCallsEnabled: boolean("phone_calls_enabled").notNull().default(false),
  /*
    Whether Maya answers this Business's line at all (issue #43).

    Off by default, and the same shape as `phoneCallsEnabled` above for the same
    reason: an account that has not asked to have its phone answered must not
    have it answered. The inbound webhook checks this before anything else it
    could spend money on.

    Turning it on requires `emergencyLine` to be set — enforced in
    lib/settings/inbound.ts, not here. A NOT NULL on that column would demand a
    value from every account that will never use inbound.
  */
  inboundEnabled: boolean("inbound_enabled").notNull().default(false),
  /*
    Inbound Calls are metered separately from the outbound `callQuota`.

    An account chooses when to place a Call and does not choose when its phone
    rings, so one counter for both would let a busy Tuesday silently consume the
    Calls somebody was saving. Twenty is a starting allowance, not a price.
  */
  inboundQuota: integer("inbound_quota").notNull().default(20),
  inboundCallsUsed: integer("inbound_calls_used").notNull().default(0),
  /*
    The number Maya reads out when a caller describes a medical, safety or legal
    emergency, before ending the Call (SPEC.md §14 rule 10).

    This is the single highest-risk path in the inbound feature. An after-hours
    clinic line receives "I'm in a lot of pain, what should I do?" in its first
    week, and the only acceptable answer is a real number and a hang-up.
  */
  emergencyLine: text("emergency_line"),
  /*
    The Talk-to-us widget (issue #45).

    `widgetKey` appears in the embed snippet on a public page, so it is not a
    secret and authorises nothing on its own — `widgetOrigins` is what makes a
    stolen key useless anywhere but the Business's own site. Null until somebody
    turns the widget on: an account that never enabled it must not have a usable
    key sitting in the database.

    `widgetDailyCap` is the ceiling that holds when both of those are defeated.
    Separate from `inboundQuota` on purpose — that is the account's allowance
    across every channel, this is a per-day rate on one of them, so a bad
    afternoon on the website cannot quietly eat what somebody was holding for
    the phone. Both apply; the lower one wins.
  */
  widgetKey: text("widget_key").unique(),
  widgetOrigins: text("widget_origins")
    .array()
    .notNull()
    .default(sql`'{}'`),
  widgetDailyCap: integer("widget_daily_cap").notNull().default(25),
  isAdmin: boolean("is_admin").notNull().default(false),
  googleCalendarId: text("google_calendar_id"),
  googleRefreshToken: text("google_refresh_token"),
  /*
    When Callzie last found the Google grant gone, discovered by a refresh that
    came back `invalid_grant`.

    That covers two causes and deliberately does not distinguish them, because
    the honest thing to tell an owner is the same for both: the connection is
    gone, reconnect. One is an owner revoking access at myaccount.google.com.
    The other is ordinary expiry — Google issues a **seven-day** refresh token
    to any app whose consent screen is in Testing status and which asks for
    anything outside name, email and profile, and ADR-0004 ships this
    integration in Testing status on purpose.

    So this is not `google_revoked_at`. Six days out of seven that name would be
    a lie.

    A column rather than one of `GOOGLE_STATUSES`, because those ride on a query
    parameter from the OAuth callback's redirect. This is discovered by a
    background push with nobody watching, so there is no redirect to carry it.
    Cleared by `storeGoogleConnection` on reconnect.
  */
  googleAccessLostAt: timestamp("google_access_lost_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const businessHours = pgTable(
  "business_hours",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    weekday: integer("weekday").notNull(), // 0 = Sunday
    opensAt: time("opens_at").notNull(),
    closesAt: time("closes_at").notNull(),
  },
  (t) => [unique("business_hours_business_weekday_uniq").on(t.businessId, t.weekday)],
);

export const services = pgTable("services", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id")
    .notNull()
    .references(() => businesses.id),
  name: text("name").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id),
    name: text("name").notNull(),
    // E.164 only. Validated on the way in (SPEC.md §3 rule 10) — bad rows are
    // rejected with a per-row reason rather than normalised silently.
    phoneE164: text("phone_e164").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    // Derived from the Service duration at write time, so the exclusion
    // constraint has a range to compare.
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    status: text("status").$type<AppointmentStatus>().notNull().default("pending"),
    needsAttentionReason: text("needs_attention_reason").$type<NeedsAttentionReason>(),
    googleEventId: text("google_event_id"),
    /*
      The Google Calendar event ids Callzie has already raised a Collision about
      for this Appointment.

      **`clearNeedsAttention` does not touch this, and that is the whole point.**
      Clearing a Collision means "a human has seen this" (SPEC.md §5), so the
      same overlapping event must not raise it again on the next check five
      seconds later. Without this column, Clear would undo itself and the button
      would look broken. A *new* overlapping event has an id that is not in here,
      so it still raises — which is correct, because it is genuinely new.

      A Reschedule **does** wipe it (`lib/appointments/reschedule.ts`). A new
      time is a new question: events that conflicted with 10:00 say nothing
      about 16:00.
    */
    collisionEventIds: text("collision_event_ids")
      .array()
      .notNull()
      .default(sql`'{}'`),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("appointments_business_id_status_idx").on(t.businessId, t.status),
    index("appointments_business_id_starts_at_idx").on(t.businessId, t.startsAt),
  ],
);

export const calls = pgTable(
  "calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /*
      Nullable since issue #43, and guarded by a CHECK rather than by this
      column's type.

      An inbound Call has no Appointment when it starts and may never get one —
      somebody ringing to ask what time you close is a Call about nothing that
      is booked. An outbound Call still must have one, and
      `calls_outbound_has_appointment` in drizzle/0006_inbound.sql is what
      enforces that. Do not re-add `.notNull()` here; do not remove the CHECK.
    */
    appointmentId: uuid("appointment_id").references(() => appointments.id),
    /*
      The tenant, on the row itself.

      Not redundant with the Appointment's `business_id`. Before inbound, every
      Call reached its Business by joining through `appointments` — which an
      inbound Call cannot do, because it has no Appointment. Every scoped read of
      this table now uses this column instead of that join.
    */
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    direction: text("direction")
      .$type<CallDirection>()
      .notNull()
      .default("outbound"),
    /*
      Who rang, in E.164. Inbound only — on an outbound Call the destination
      lives on the Appointment, and duplicating it here would create two places
      to look and one of them to be wrong.
    */
    fromNumber: text("from_number"),
    // Nullable: the row is written as `queued` before Retell returns an id.
    retellCallId: text("retell_call_id").unique(),
    callType: text("call_type").$type<CallType>().notNull(),
    attempt: integer("attempt").notNull().default(1),
    status: text("status").$type<CallStatus>().notNull().default("queued"),
    durationSeconds: integer("duration_seconds"),
    recordingUrl: text("recording_url"),
    transcript: text("transcript"),
    /*
      Retell's `transcript_object`, kept as `{ role, content, startSeconds }` per
      turn — see `parseTranscriptObject` in lib/calls/transcript.ts for what is
      dropped and why.

      Nullable, and permanently so. It arrives on `call_analyzed` while the plain
      `transcript` above arrives on `call_ended`, so every Call has a window in
      which this is null and the text column is the only transcript there is.
      Nothing on the Call detail screen may require this column.
    */
    transcriptTurns: jsonb("transcript_turns").$type<StoredTurn[]>(),
    // Retell sends this as `disconnection_reason` on the call_ended payload —
    // note the spelling difference when mapping (docs/verification.md A9).
    disconnectReason: text("disconnect_reason"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    index("calls_appointment_id_idx").on(t.appointmentId),
    index("calls_business_id_direction_idx").on(t.businessId, t.direction),
    /*
      For the inbound webhook's rate limit, which counts recent Calls from one
      number on every single inbound Call — inside Retell's 10-second budget.
      Without this it is a sequential scan of every Call on the platform.
    */
    index("calls_from_number_created_at_idx").on(t.fromNumber, t.createdAt),
  ],
);

/*
  What an inbound Call produced (issue #43).

  Tool-written, during the Call. The distinction from `extractions` below is the
  same one SPEC.md §9 step 3 draws and it is worth restating: this records what
  the Agent DID, `extractions` records what was SAID. A caller who booked has a
  row here whether or not the extraction pass ever ran, and a failed extraction
  can never erase it.
*/
export const enquiries = pgTable(
  "enquiries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Unique: one Enquiry per Call. A Call is one conversation and it had one
    // outcome, even when several things were discussed inside it.
    callId: uuid("call_id")
      .notNull()
      .unique()
      .references(() => calls.id),
    kind: text("kind").$type<EnquiryKind>().notNull(),
    callerName: text("caller_name"),
    callerPhoneE164: text("caller_phone_e164"),
    // What they rang about, in Maya's words. Free text on purpose — the point is
    // for a human to read it, not for anything to branch on it.
    topic: text("topic"),
    // Set only when this Call ended in a booking. Null for every other kind.
    appointmentId: uuid("appointment_id").references(() => appointments.id),
    /*
      Whether a human has dealt with it. The `needs_attention` equivalent for
      Enquiries — a complaint or a callback request sits unresolved until
      somebody clears it, and Callzie never clears one itself (CONTEXT.md).
    */
    resolved: boolean("resolved").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("enquiries_resolved_idx").on(t.resolved)],
);

// What the Agent DID, mid-call. This — not `extractions` — is the authoritative
// record of the outcome (SPEC.md §9 step 3). If a Tool committed, the Tool wins.
export const toolInvocations = pgTable(
  "tool_invocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id),
    toolName: text("tool_name").$type<ToolName>().notNull(),
    arguments: jsonb("arguments").notNull(),
    result: jsonb("result"),
    succeeded: boolean("succeeded").notNull(),
    // How long the endpoint took, in milliseconds. A slow Tool is dead air on a
    // live call (issue #10), and docs/verification.md A12 records the latency
    // budget as unverified — this column is what will settle it.
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  /*
    Not declared here: `tool_invocations_one_booking_per_call`, the partial
    unique index that caps a Call at one committed Reschedule. It lives in
    drizzle/0003_tool_invocations.sql, alongside 0001's EXCLUDE constraint, and
    lib/db/schema.test.ts parses that file to prove the rule still says what
    lib/tools/run.ts assumes.
  */
  (t) => [index("tool_invocations_call_id_idx").on(t.callId)],
);

// What was SAID. Covers only what Tools cannot produce.
export const extractions = pgTable("extractions", {
  id: uuid("id").primaryKey().defaultRandom(),
  callId: uuid("call_id")
    .notNull()
    .unique()
    .references(() => calls.id),
  notes: text("notes"),
  summary: text("summary"),
  sentiment: text("sentiment").$type<Sentiment>(),
  // Sourced from Retell's call_analysis.in_voicemail rather than inferred by the
  // extraction LLM (SPEC.md §9 step 4).
  inVoicemail: boolean("in_voicemail"),
  // Fallback fields ONLY — populated when no Tool committed, so an outcome can
  // still be reconstructed from a Call where the Agent invoked nothing. Never
  // overwrite a Tool-written outcome with these.
  confirmed: boolean("confirmed"),
  newTime: text("new_time"),
  status: text("status").$type<ExtractionStatus>().notNull().default("ok"),
  // Kept so a failed parse stays debuggable instead of vanishing (SPEC.md §3 rule 5).
  rawLlmOutput: text("raw_llm_output"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    retellCallId: text("retell_call_id"),
    eventType: text("event_type"),
    payload: jsonb("payload").notNull(),
    // Dedupe key is (retell_call_id, event_type) + this flag. A row that exists
    // but is NOT processed must be retried, not skipped — Retell's 10s timeout
    // means a slow first attempt gets redelivered mid-work.
    processed: boolean("processed").default(false),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    unique("webhook_events_call_event_uniq").on(t.retellCallId, t.eventType),
    index("webhook_events_retell_call_id_idx").on(t.retellCallId),
  ],
);

/*
  The number a Business is reached on (issue #43).

  The inbound webhook is handed a `to_number` and nothing else, so this table is
  the only thing that can say whose phone just rang. Purchasing and releasing
  numbers against Retell is issue #44; this is the mapping alone.
*/
export const PHONE_NUMBER_PURPOSES = ["inbound", "outbound", "both"] as const;
export type PhoneNumberPurpose = (typeof PHONE_NUMBER_PURPOSES)[number];

export const phoneNumbers = pgTable(
  "phone_numbers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    /*
      Unique, and that is the whole design. Two Businesses sharing a number
      would leave the inbound webhook unable to say whose customer is calling.
      The database refuses it rather than the application remembering to.
    */
    e164: text("e164").notNull().unique(),
    // Null until issue #44 provisions the number against Retell.
    retellNumberId: text("retell_number_id"),
    purpose: text("purpose")
      .$type<PhoneNumberPurpose>()
      .notNull()
      .default("inbound"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [index("phone_numbers_business_id_idx").on(t.businessId)],
);

// The four Retell Agents provisioned by scripts/create-agent.ts (SPEC.md §7),
// one per Template. Keyed by business_type — not by business — because SPEC.md §4
// fixes exactly one Template per Business Type, so this is a small lookup table
// that every account shares, never a per-Business mapping.
//
// Written only by the script, read on the Web Call path. It lives in Postgres
// rather than in env vars because the ids differ per Retell workspace, and
// Cloud Run already receives DATABASE_URL — so nothing new has to be wired into
// the deploy. See ADR-0006.
// Since issue #43 the key is (business_type, direction): there are two Agents per
// Business Type, one that calls out and one that answers. A composite key rather
// than nullable `inbound_*` columns, so "not created yet" stays distinguishable
// from "does not exist" — see drizzle/0006_inbound.sql.
export const retellAgents = pgTable(
  "retell_agents",
  {
    businessType: text("business_type").$type<BusinessType>().notNull(),
    direction: text("direction")
      .$type<CallDirection>()
      .notNull()
      .default("outbound"),
    llmId: text("llm_id").notNull(),
    agentId: text("agent_id").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => [
    primaryKey({
      name: "retell_agents_pkey",
      columns: [t.businessType, t.direction],
    }),
  ],
);

export const schema = {
  users,
  businesses,
  businessHours,
  services,
  appointments,
  calls,
  toolInvocations,
  extractions,
  enquiries,
  webhookEvents,
  phoneNumbers,
  retellAgents,
};
