-- Hand-written. Drizzle cannot express an EXCLUDE constraint, so this migration is
-- maintained by hand and is intentionally absent from the meta snapshot.
--
-- SPEC.md §3 rule 8: Slot uniqueness is a database constraint, not application
-- logic. SPEC.md §5 permits three concurrent Calls, and three Agents running
-- check_availability -> book_slot will find any gap between the read and the write.
-- A plain unique index cannot express this because Appointments occupy ranges,
-- not points.
--
-- Declined and cancelled Appointments are excluded from the constraint so their
-- Slots become bookable again. Unreachable ones are NOT excluded — an unanswered
-- phone is not a cancellation, and the Slot stays held (SPEC.md §14 rule 2).

CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_no_overlap"
  EXCLUDE USING gist (
    "business_id" WITH =,
    tstzrange("starts_at", "ends_at") WITH &&
  ) WHERE (status NOT IN ('declined', 'cancelled'));
