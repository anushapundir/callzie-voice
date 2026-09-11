/**
 * Whether an error is the no-overlap constraint refusing an overlapping Slot.
 *
 * Its own file because two writers need it: `lib/availability/book.ts` inserts a
 * new Appointment for the quick-add card, and `lib/appointments/reschedule.ts`
 * moves an existing one during a Call. Both hit `appointments_no_overlap`, and
 * both have to tell "someone took that Slot" apart from "the connection
 * dropped" — SPEC.md §3 rule 7 says Maya must never claim a booking succeeded
 * when the Tool failed, and §8 retries once before giving up. Neither is
 * servable if every error looks the same.
 *
 * Shared rather than copied. A copy would be one of two places to fix, and the
 * failure mode of fixing only one is that a lost race is thrown at Maya as a
 * Tool failure instead of coming back as an offer of another time.
 */

/** Postgres `exclusion_violation`. */
const EXCLUSION_VIOLATION = "23P01";
const NO_OVERLAP_CONSTRAINT = "appointments_no_overlap";

/**
 * Both the SQLSTATE and the constraint name are checked. The code alone would
 * also match a future exclusion constraint on some other table, and reading that
 * as "Slot taken" would make Maya offer an alternative time for a problem that
 * has nothing to do with the Slot.
 *
 * The `cause` chain has to be walked, and this is the part that is easy to get
 * wrong. Drizzle does not hand back the error `pg` raised: it wraps it in a
 * `DrizzleQueryError` carrying the SQL and the parameters, and puts the original
 * on `cause`. So the SQLSTATE is one level down, and a check that only looked at
 * the top-level error would never match — every lost race would be thrown at
 * Maya as a Tool failure instead of coming back as an offer of another time.
 * Both levels are checked so this keeps working if Drizzle ever stops wrapping.
 */
export function isSlotTaken(error: unknown): boolean {
  // Three levels is plenty for one wrapper, and a fixed limit means a cyclic
  // `cause` cannot spin here.
  for (let current = error, depth = 0; depth < 3; depth++) {
    if (typeof current !== "object" || current === null) return false;
    const { code, constraint } = current as { code?: string; constraint?: string };
    if (code === EXCLUSION_VIOLATION && constraint === NO_OVERLAP_CONSTRAINT) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
