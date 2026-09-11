-- Hand-written, following drizzle/0001's precedent: a partial unique index is a
-- rule Drizzle's schema DSL does not round-trip cleanly, and this one is
-- load-bearing enough to be worth reading as SQL.
--
-- `latency_ms` — issue #10 requires latency to be recorded, and
-- docs/verification.md A12 names this ticket as what settles the Tool latency
-- budget. Nullable on purpose: a row written after a crash may have nothing to
-- record, and NOT NULL would turn a failed Tool into a failed record of one.

ALTER TABLE "tool_invocations" ADD COLUMN "latency_ms" integer;
--> statement-breakpoint
-- CONTEXT.md: "One Reschedule commits per Call, however many Offers preceded
-- it." Enforced here rather than in application code for the same reason
-- appointments_no_overlap is — a check in code is a check someone can delete
-- without a test going red.
--
-- Read the WHERE clause carefully; it is the whole design:
--   * unlimited check_availability rows per Call — the negotiation is the
--     product's best moment (SPEC.md §7) and nothing may cap it;
--   * unlimited FAILED book_slot rows — SPEC.md §8 retries once, and losing a
--     Slot to a concurrent Call is an ordinary outcome Maya answers by offering
--     another time;
--   * exactly one SUCCESSFUL book_slot.
CREATE UNIQUE INDEX "tool_invocations_one_booking_per_call"
  ON "tool_invocations" ("call_id")
  WHERE "tool_name" = 'book_slot' AND "succeeded";
