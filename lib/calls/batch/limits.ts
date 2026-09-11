/*
  The three numbers Call All is bounded by (issue #17).

  They live alone, with no database import, so a client component can read
  MAX_CONCURRENT_CALLS without dragging `pg` into the browser bundle.
*/

/**
 * How many Calls Callzie will run at once.
 *
 * **This is a cost and pacing decision, not a platform limit.** A Retell
 * Pay-As-You-Go workspace is allowed twenty concurrent Calls and the first
 * twenty are free (`docs/verification.md` A10). Three is what keeps a demo
 * watchable and a five-Call Quota from vanishing in one press.
 *
 * The README owes this sentence — SPEC.md §12's M7 deliverable, tracked on
 * issue #21 — because "we cap at three" reads as a platform constraint unless
 * it says otherwise. See ADR-0013.
 */
export const MAX_CONCURRENT_CALLS = 3;

/**
 * How many Appointments one press may queue.
 *
 * A bound on the shape of a request rather than a product rule, matching
 * `MAX_CSV_ROWS`. The Quota is the real limit for every account that is not an
 * admin; this stops an admin's single press from queueing a thousand rows.
 */
export const MAX_BATCH_SIZE = 200;

/**
 * Attempts before an Appointment is declared unreachable.
 *
 * Two: the first Call, and the one retry issue #17 asks for.
 */
export const MAX_ATTEMPTS = 2;
