import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  APPOINTMENT_STATUSES,
  SLOT_FREEING_STATUSES,
  SLOT_HOLDING_STATUSES,
} from "@/lib/db/schema";

/*
  No database needed. This guards a very specific way for this feature to break
  silently: someone edits the EXCLUDE constraint's WHERE clause in the migration
  and does not edit the query in lib/availability/find.ts, or the other way
  round. Nothing about that would fail to compile, and Availability would start
  disagreeing with the database about which Slots are free.
*/

const MIGRATION = readFileSync(
  "./drizzle/0001_appointments_no_overlap.sql",
  "utf8",
);

describe("SLOT_FREEING_STATUSES", () => {
  it("lists exactly the statuses the EXCLUDE constraint exempts", () => {
    // Pull the statuses out of `WHERE (status NOT IN ('declined', 'cancelled'))`
    const where = /status NOT IN \(([^)]*)\)/.exec(MIGRATION);
    expect(where, "migration 0001 no longer has a `status NOT IN (...)` clause")
      .not.toBeNull();

    const inMigration = [...where![1].matchAll(/'([a-z_]+)'/g)]
      .map((m) => m[1])
      .sort();

    expect(inMigration).toEqual([...SLOT_FREEING_STATUSES].sort());
  });
});

describe("SLOT_HOLDING_STATUSES", () => {
  it("is every other status", () => {
    expect([...SLOT_HOLDING_STATUSES].sort()).toEqual(
      APPOINTMENT_STATUSES.filter(
        // Cast because SLOT_FREEING_STATUSES is a two-string tuple, so `includes`
        // will not accept any other status. The runtime check is the point.
        (s) => !(SLOT_FREEING_STATUSES as readonly string[]).includes(s),
      ).sort(),
    );
  });

  it("holds the Slot for an unreachable Appointment", () => {
    // SPEC.md §14 rule 2: an unanswered phone is not a cancellation.
    expect(SLOT_HOLDING_STATUSES).toContain("unreachable");
  });

  it("gives Call All somewhere to queue an Appointment", () => {
    /*
      A queued Appointment is waiting for a free slot in the throttle (issue
      #17). Nobody has said anything about the booking, so the Slot is still
      theirs — the same rule as the case above.
    */
    expect(APPOINTMENT_STATUSES).toContain("queued");
    expect(SLOT_HOLDING_STATUSES).toContain("queued");
  });
});

/*
  The same guard, for the rule issue #10 added. lib/tools/run.ts turns a
  violation of this index into "you already booked on this Call" — so if someone
  widens the WHERE clause, SPEC.md §8's silent retry stops working, and if they
  drop `succeeded`, a Call can commit two Reschedules. Neither would fail to
  compile, and neither would fail any test that did not read the SQL.
*/
const TOOL_MIGRATION = readFileSync("./drizzle/0003_tool_invocations.sql", "utf8");

describe("the one-booking-per-call index", () => {
  it("applies only to successful book_slot rows", () => {
    const where =
      /CREATE UNIQUE INDEX "tool_invocations_one_booking_per_call"[\s\S]*?WHERE ([^;]+)/.exec(
        TOOL_MIGRATION,
      );
    expect(where, "migration 0003 no longer creates that index").not.toBeNull();

    const clause = where![1].replace(/\s+/g, " ").trim();
    expect(clause).toContain(`"tool_name" = 'book_slot'`);
    expect(clause).toContain(`"succeeded"`);
  });

  it("is keyed on the Call, not the Appointment", () => {
    // Per Call is the rule CONTEXT.md states. Per Appointment would refuse a
    // legitimate second Reschedule on a later Call.
    expect(TOOL_MIGRATION).toMatch(/ON "tool_invocations" \("call_id"\)/);
  });

  it("records how long each invocation took", () => {
    // Acceptance criterion 6. Without the column there is nothing to record in.
    expect(TOOL_MIGRATION).toMatch(/ADD COLUMN "latency_ms" integer/);
  });
});

/*
  The same guard again, for issue #43's rules. Both of these are the kind of
  thing that can be deleted from the SQL without a single test going red unless
  something reads the SQL — which is what this file is for.
*/
const INBOUND_MIGRATION = readFileSync("./drizzle/0006_inbound.sql", "utf8");

describe("calls_outbound_has_appointment", () => {
  it("still requires an Appointment on every outbound Call", () => {
    /*
      This constraint is the whole reason dropping NOT NULL from
      `appointment_id` is safe. Without it an outbound Call could be written
      with no Appointment — a row no screen renders and no query finds.
    */
    const check =
      /ADD CONSTRAINT "calls_outbound_has_appointment"\s*CHECK \(([^;]+)\)/.exec(
        INBOUND_MIGRATION,
      );
    expect(check, "migration 0006 no longer adds that CHECK").not.toBeNull();

    const clause = check![1].replace(/\s+/g, " ").trim();
    expect(clause).toContain(`"direction" = 'inbound'`);
    expect(clause).toContain(`"appointment_id" IS NOT NULL`);
  });

  it("drops NOT NULL from appointment_id, and only after the backfill", () => {
    // Order matters: `business_id` is added nullable, backfilled, then made NOT
    // NULL. Adding it NOT NULL outright fails on any database with a Call in it.
    const backfill = INBOUND_MIGRATION.indexOf(`UPDATE "calls" SET "business_id"`);
    const setNotNull = INBOUND_MIGRATION.indexOf(
      `ALTER COLUMN "business_id" SET NOT NULL`,
    );

    expect(backfill).toBeGreaterThan(-1);
    expect(setNotNull).toBeGreaterThan(backfill);
    expect(INBOUND_MIGRATION).toMatch(
      /ALTER COLUMN "appointment_id" DROP NOT NULL/,
    );
  });
});

describe("the one-new-booking-per-call index", () => {
  it("applies only to successful book_appointment rows", () => {
    // The twin of 0003's index, for the Tool that creates an Appointment rather
    // than moving one. Widening it would let one inbound Call take any number
    // of Slots.
    const where =
      /CREATE UNIQUE INDEX "tool_invocations_one_new_booking_per_call"[\s\S]*?WHERE ([^;]+)/.exec(
        INBOUND_MIGRATION,
      );
    expect(where, "migration 0006 no longer creates that index").not.toBeNull();

    const clause = where![1].replace(/\s+/g, " ").trim();
    expect(clause).toContain(`"tool_name" = 'book_appointment'`);
    expect(clause).toContain(`"succeeded"`);
  });

  it("is a separate index from the one that caps Reschedules", () => {
    // Two rules, two indexes. They will diverge: one caps Reschedules on a Call
    // Callzie placed, the other caps what a stranger can take on one inbound
    // Call.
    expect(INBOUND_MIGRATION).not.toContain(
      `"tool_invocations_one_booking_per_call"`,
    );
  });
});
