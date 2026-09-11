import type { ToolName } from "@/lib/db/schema";
import type { OfferedSlot } from "@/lib/tools/offers";

/*
  The Outcome card's model, built from `tool_invocations`.

  This is the authoritative record of what happened on a Call (SPEC.md §9
  step 3), and it is deliberately built from the rows the Tool endpoints wrote
  mid-Call rather than from `extractions`, which is only what was said
  afterwards. When the two disagree, this wins — on the screen as well as in
  `lib/extraction/outcome.ts`.

  Everything here is defensive about `arguments` and `result`, which are jsonb.
  A row written by an older version of a Tool must not be able to throw inside a
  page render — the same contract `offeredSlotsInCall` in lib/tools/offers.ts
  states for the same columns.
*/

/** One `tool_invocations` row, as the loader reads it. */
export type InvocationRow = {
  id: string;
  toolName: ToolName;
  arguments: unknown;
  result: unknown;
  succeeded: boolean;
  latencyMs: number | null;
  createdAt: Date;
};

export type CallOutcome = {
  /** Every invocation, in the order it ran. Failures included, in place. */
  invocations: InvocationRow[];
  /** Every Slot this Call actually named, deduped, in first-seen order. */
  offeredSlots: OfferedSlot[];
  /** What a successful `book_slot` read back to the person, or null. */
  bookedTime: string | null;
  /**
   * Did any Tool write an outcome?
   *
   * The same question `aToolCommitted` in lib/extraction/outcome.ts asks of the
   * database, answered here from rows already in hand. `check_availability` is
   * not one of these: it is a read, and a Call where Maya only ever checked
   * times is a Call where no Tool committed.
   */
  aToolCommitted: boolean;
};

const COMMITTING_TOOLS: readonly ToolName[] = [
  "book_slot",
  "confirm_appointment",
  "cancel_appointment",
];

export function callOutcome(rows: InvocationRow[]): CallOutcome {
  const invocations = [...rows].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );

  const offeredSlots: OfferedSlot[] = [];
  const seen = new Set<string>();
  let bookedTime: string | null = null;
  let aToolCommitted = false;

  for (const row of invocations) {
    if (row.succeeded && COMMITTING_TOOLS.includes(row.toolName)) {
      aToolCommitted = true;
    }

    // A check that failed offered nothing, whatever is in its result.
    if (row.toolName === "check_availability" && row.succeeded) {
      for (const slot of slotsIn(row.result)) {
        if (seen.has(slot.slot_start)) continue;
        seen.add(slot.slot_start);
        offeredSlots.push(slot);
      }
    }

    if (row.toolName === "book_slot" && row.succeeded) {
      bookedTime = bookedTimeIn(row.result) ?? bookedTime;
    }
  }

  return { invocations, offeredSlots, bookedTime, aToolCommitted };
}

/** `check_availability`'s `{ ok: true, slots: [{ slot_start, time }] }`. */
function slotsIn(result: unknown): OfferedSlot[] {
  if (typeof result !== "object" || result === null) return [];

  const { slots } = result as Record<string, unknown>;
  if (!Array.isArray(slots)) return [];

  const offered: OfferedSlot[] = [];

  for (const slot of slots) {
    if (typeof slot !== "object" || slot === null) continue;

    const { slot_start, time } = slot as Record<string, unknown>;
    if (typeof slot_start !== "string" || slot_start === "") continue;

    offered.push({
      slot_start,
      // The spoken form is what Maya said out loud. Falling back to the ISO
      // token keeps the card readable rather than blank on an older row.
      time: typeof time === "string" ? time : slot_start,
    });
  }

  return offered;
}

/** `book_slot`'s `{ ok: true, booked_time }` — the spoken form, not the ISO one. */
function bookedTimeIn(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;

  const { booked_time } = result as Record<string, unknown>;
  return typeof booked_time === "string" && booked_time !== "" ? booked_time : null;
}

/**
 * A tool latency past this is drawn in the attention colour.
 *
 * A tool call happens while the person is on the phone waiting. Anything over a
 * second and a half is dead air they can hear, so the number has to stand out
 * rather than sit in the same grey as the fast ones.
 */
export const SLOW_TOOL_MS = 1500;

/**
 * What each tool is called on screen, in words a salon owner reads.
 *
 * The screen used to print the raw name — `check_availability` — beside two
 * blocks of JSON. That is the engineer's name for it, and nobody outside this
 * repo has any reason to know it. The mono name is still shown, but inside the
 * row's `<details>`, where somebody debugging goes looking for it.
 */
const TOOL_LABELS: Record<ToolName, string> = {
  check_availability: "Checked availability",
  book_slot: "Moved the appointment",
  confirm_appointment: "Confirmed the appointment",
  cancel_appointment: "Cancelled the appointment",
  book_appointment: "Booked a new appointment",
  lookup_appointment: "Looked up the appointment",
  log_enquiry: "Logged what the caller wanted",
};

/**
 * One line of the outcome ledger — what this tool call actually did.
 *
 * Two tools say more when they succeeded than their name does, so they get a
 * sentence built from the result: a check that came back with times says how
 * many were offered, and a booking says the time it booked.
 *
 * `tool_name` is a plain `text` column, so a row written by a newer version of
 * a tool can carry a name this map has never heard of. Falling back to the raw
 * name keeps the row readable instead of printing "undefined" at somebody.
 */
export function invocationLabel(row: InvocationRow): string {
  if (row.succeeded && row.toolName === "check_availability") {
    const offered = slotsIn(row.result).length;
    if (offered > 0) {
      return `Offered ${offered} ${offered === 1 ? "time" : "times"}`;
    }
  }

  if (
    row.succeeded &&
    (row.toolName === "book_slot" || row.toolName === "book_appointment")
  ) {
    const time = bookedTimeIn(row.result);
    if (time) return `Booked ${time}`;
  }

  return TOOL_LABELS[row.toolName] ?? row.toolName;
}

/**
 * The one line the whole Call detail screen is built around.
 *
 * It goes directly under the header, before any evidence, because the first
 * question anybody opening this screen has is "did it get booked". Everything
 * below — the recording, the transcript, the ledger — is there to back this
 * sentence up, and until it existed a reader had to assemble it themselves out
 * of a status pill and a card halfway down the right-hand column.
 *
 * `bookedTime` arrives already formatted. The caller knows the business's
 * timezone and this module does not, and a time rendered in the wrong zone is
 * the one mistake on this screen nobody would spot.
 */
export function callVerdict({
  connected,
  bookedTime,
  personName,
}: {
  /** False when the call never became a conversation — no answer, or failed. */
  connected: boolean;
  bookedTime: string | null;
  personName: string;
}): string {
  if (!connected) return `Maya could not reach ${personName}.`;
  return bookedTime ? `Booked, ${bookedTime}.` : "Nothing booked.";
}
