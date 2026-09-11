import { sql } from "drizzle-orm";

import { schema } from "@/lib/db";
import { ENQUIRY_KINDS, type EnquiryKind } from "@/lib/db/schema";
import { parseE164 } from "@/lib/appointments/phone";
import type { InboundToolContext } from "@/lib/tools/request";
import type { ToolHandler } from "@/lib/tools/run";

/**
 * `log_enquiry` — what the call was about, when it did not end in a booking
 * (issue #43).
 *
 * This is the Tool that makes an unanswered phone worth answering. A caller who
 * asks a question, complains, or wants somebody to ring them back leaves nothing
 * behind otherwise but a transcript nobody reads. The Enquiry is the row that
 * turns up on somebody's dashboard tomorrow morning.
 *
 * Tool-written, during the Call, and that is the point: it survives a failed
 * extraction pass, because SPEC.md §9 step 3 says if a Tool committed, the Tool
 * wins. A complaint must not be able to vanish because an LLM returned malformed
 * JSON afterwards.
 *
 * **`resolved` is the human's to set, never Callzie's.** A `question` is closed
 * on arrival — Maya answered it, there is nothing to do. The other three are
 * left open, and the Needs Attention surface will not stop showing them until
 * somebody clears it. Callzie never resolves one itself (CONTEXT.md).
 */

/**
 * Which kinds a human still has to act on.
 *
 * `question` is the only one Maya finishes by herself. `refused` is here
 * deliberately — a call she declined to help with is the one most likely to need
 * a person, not the least.
 */
const NEEDS_A_HUMAN: readonly EnquiryKind[] = ["complaint", "callback", "refused"];

export const logEnquiryTool: ToolHandler<InboundToolContext> = async ({
  tx,
  context,
  args,
}) => {
  const kind = parseKind(args.kind);
  if (!kind) {
    return {
      succeeded: false,
      result: {
        ok: false,
        reason: "invalid_kind",
        // No `say`. This is a mistake by the model, not something the caller
        // did, and it should retry rather than narrate a failure to them.
      },
    };
  }

  const topic = typeof args.topic === "string" ? args.topic.trim() : "";
  if (topic === "") {
    return { succeeded: false, result: { ok: false, reason: "missing_topic" } };
  }

  const callerName =
    typeof args.caller_name === "string" && args.caller_name.trim() !== ""
      ? args.caller_name.trim()
      : null;

  /*
    Falls back to the number they are ringing from, which is nearly always the
    right one and is the only number Callzie can be sure reaches them. A number
    the model misheard is worse than no number at all, so an unparseable one is
    dropped rather than stored.
  */
  const supplied = parseE164(args.callback_number);
  const callbackNumber = supplied.ok ? supplied.value : context.fromNumber;

  /*
    One Enquiry per Call — `enquiries.call_id` is UNIQUE. A second call to this
    Tool in one conversation is the model tidying up at the end after logging
    something earlier, and the later description is the better one, so it wins.

    An upsert rather than an insert that fails, because a unique violation here
    would be caught by `runTool` and turned into "something went wrong on my
    end" — a failure line read aloud over a Tool call that did nothing wrong.
  */
  await tx
    .insert(schema.enquiries)
    .values({
      callId: context.callId,
      kind,
      callerName,
      callerPhoneE164: callbackNumber,
      topic,
      resolved: !NEEDS_A_HUMAN.includes(kind),
    })
    .onConflictDoUpdate({
      target: schema.enquiries.callId,
      set: {
        kind,
        topic,
        callerName: sql`COALESCE(EXCLUDED.caller_name, ${schema.enquiries.callerName})`,
        callerPhoneE164: callbackNumber,
        resolved: !NEEDS_A_HUMAN.includes(kind),
      },
    });

  return {
    succeeded: true,
    result: {
      ok: true,
      say: NEEDS_A_HUMAN.includes(kind)
        ? "I've made a note of that and someone will get back to you."
        : "I've made a note of that.",
    },
  };
};

/** The model's string, or null. Validated against the column's own union. */
function parseKind(value: unknown): EnquiryKind | null {
  if (typeof value !== "string") return null;

  const candidate = value.trim().toLowerCase();

  /*
    `booked` is refused even though it is a valid column value. Only
    `book_appointment` may write it, because it is the one place that knows an
    Appointment row actually exists — a model that logs "booked" after a failed
    booking would put SPEC.md §3 rule 7's exact lie into the database, where the
    dashboard would repeat it.
  */
  if (candidate === "booked") return null;

  return ENQUIRY_KINDS.includes(candidate as EnquiryKind)
    ? (candidate as EnquiryKind)
    : null;
}
