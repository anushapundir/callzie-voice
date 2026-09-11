-- Inbound Calls (issue #43). Hand-written, following 0001 and 0003's precedent:
-- a CHECK constraint and two partial unique indexes are rules Drizzle's schema
-- DSL does not round-trip, and all three are load-bearing enough to read as SQL.
--
-- The ordering below is not cosmetic. `business_id` is added nullable,
-- backfilled from the Appointment each existing Call already points at, and only
-- then made NOT NULL. Adding it NOT NULL in one statement would fail on any
-- database with a Call in it, which is every deployed one.

-- ---------- businesses ----------
-- Inbound volume is not something an account controls, so it does not share the
-- outbound Quota. A separate counter means a busy afternoon on the phone cannot
-- silently eat the Calls an account was saving to place.
ALTER TABLE "businesses" ADD COLUMN "inbound_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "inbound_quota" integer NOT NULL DEFAULT 20;
--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "inbound_calls_used" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- What Maya reads out when a caller describes an emergency (SPEC.md §14 rule 10).
-- Nullable in the database, required by the application before `inbound_enabled`
-- may be turned on — a NOT NULL here would demand one from every existing
-- account, including the ones that will never answer a phone.
ALTER TABLE "businesses" ADD COLUMN "emergency_line" text;
--> statement-breakpoint

-- ---------- calls ----------
ALTER TABLE "calls" ADD COLUMN "direction" text NOT NULL DEFAULT 'outbound';
--> statement-breakpoint
-- Who rang. Inbound only; null on every outbound row, where the destination
-- lives on the Appointment instead.
ALTER TABLE "calls" ADD COLUMN "from_number" text;
--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "business_id" uuid REFERENCES "businesses"("id");
--> statement-breakpoint
-- Every existing Call is outbound and reaches its Business through its
-- Appointment. This copies that edge onto the row itself, once.
UPDATE "calls" SET "business_id" = "appointments"."business_id"
  FROM "appointments"
  WHERE "appointments"."id" = "calls"."appointment_id"
    AND "calls"."business_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "calls" ALTER COLUMN "business_id" SET NOT NULL;
--> statement-breakpoint
-- An inbound Call has no Appointment when it starts, and may never acquire one.
ALTER TABLE "calls" ALTER COLUMN "appointment_id" DROP NOT NULL;
--> statement-breakpoint
-- This constraint is the reason dropping NOT NULL above is safe, not an
-- afterthought to it. Without it, an outbound Call could be written with no
-- Appointment — a silent orphan that no screen would render and no query would
-- find, rather than an error at the moment somebody wrote the bug.
ALTER TABLE "calls" ADD CONSTRAINT "calls_outbound_has_appointment"
  CHECK ("direction" = 'inbound' OR "appointment_id" IS NOT NULL);
--> statement-breakpoint
CREATE INDEX "calls_business_id_direction_idx" ON "calls" ("business_id", "direction");
--> statement-breakpoint
-- The inbound webhook's abuse guard counts recent Calls from one number, and it
-- runs inside Retell's 10-second budget on every single inbound Call. Without
-- this index that count is a sequential scan of every Call on the platform.
CREATE INDEX "calls_from_number_created_at_idx" ON "calls" ("from_number", "created_at");
--> statement-breakpoint

-- ---------- enquiries ----------
-- What an inbound Call produced, written by a Tool during the Call. Deliberately
-- not folded into `extractions`: that table holds what the LLM read out of a
-- transcript afterwards, and this holds what the Agent actually did. Keeping
-- them apart is the same discipline SPEC.md §9 step 3 states — if a Tool
-- committed, the Tool wins.
CREATE TABLE "enquiries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "call_id" uuid NOT NULL UNIQUE REFERENCES "calls"("id"),
  "kind" text NOT NULL,
  "caller_name" text,
  "caller_phone_e164" text,
  "topic" text,
  -- Set only when the Call ended in a booking. Null for every other kind.
  "appointment_id" uuid REFERENCES "appointments"("id"),
  "resolved" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
-- The Needs Attention surface reads open Enquiries per Business, and it renders
-- on every dashboard load.
CREATE INDEX "enquiries_resolved_idx" ON "enquiries" ("resolved");
--> statement-breakpoint

-- ---------- retell_agents ----------
-- There are now two Agents per Business Type — one that calls out, one that
-- answers — so `business_type` alone no longer identifies a row.
--
-- A composite key rather than a pair of nullable `inbound_*` columns on the
-- existing row. Nullable columns would make one row mean two things and leave
-- "the inbound agent has not been created yet" indistinguishable from "this
-- Business Type has no inbound agent", which is exactly the ambiguity the
-- reconcile pass in scripts/create-agent.ts exists to resolve.
ALTER TABLE "retell_agents" ADD COLUMN "direction" text NOT NULL DEFAULT 'outbound';
--> statement-breakpoint
ALTER TABLE "retell_agents" DROP CONSTRAINT "retell_agents_pkey";
--> statement-breakpoint
ALTER TABLE "retell_agents" ADD CONSTRAINT "retell_agents_pkey"
  PRIMARY KEY ("business_type", "direction");
--> statement-breakpoint

-- ---------- one new booking per Call ----------
-- The twin of `tool_invocations_one_booking_per_call` from 0003, for the Tool
-- that creates an Appointment rather than moving one.
--
-- A separate index, not a widened WHERE on the existing one, because the two
-- rules mean different things and will diverge: that one caps Reschedules on a
-- Call Callzie placed, this one caps how many Slots a stranger can take on a
-- single inbound Call. Read the WHERE the same way as 0003's — unlimited failed
-- attempts, because losing a Slot to a concurrent Call is an ordinary outcome
-- Maya answers by offering another time, and exactly one success.
CREATE UNIQUE INDEX "tool_invocations_one_new_booking_per_call"
  ON "tool_invocations" ("call_id")
  WHERE "tool_name" = 'book_appointment' AND "succeeded";
