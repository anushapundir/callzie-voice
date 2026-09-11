-- The number a Business is reached on (issue #43).
--
-- Split from 0006 because it answers a different question. 0006 makes a Call
-- able to exist without an Appointment; this makes an incoming call findable —
-- the inbound webhook is handed a `to_number` and nothing else, so this table is
-- the only thing that can say whose phone just rang.
--
-- Provisioning against Retell — purchasing, binding, releasing — is issue #44.
-- This is the mapping alone, which #43 cannot work without.

CREATE TABLE "phone_numbers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "business_id" uuid NOT NULL REFERENCES "businesses"("id"),
  -- E.164, and UNIQUE is the load-bearing word. Two Businesses sharing a number
  -- would leave the inbound webhook unable to say whose customer is calling,
  -- and the honest place to make that impossible is here rather than in a check
  -- somebody has to remember to write.
  "e164" text NOT NULL UNIQUE,
  -- Retell's own id for the number, so a row can never point at a number that
  -- was released, and a purchased number can never be orphaned with no row.
  -- Null until issue #44 provisions it.
  "retell_number_id" text,
  -- inbound | outbound | both
  "purpose" text NOT NULL DEFAULT 'inbound',
  "created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
-- The webhook looks up by number on every inbound Call, inside Retell's
-- ten-second budget. The UNIQUE above already provides this index; it is named
-- here only so the intent is readable next to the query that depends on it.
CREATE INDEX "phone_numbers_business_id_idx" ON "phone_numbers" ("business_id");
