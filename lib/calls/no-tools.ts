import type { CallStatus, ExtractionStatus } from "@/lib/db/schema";

/*
  What the Outcome card says when `tool_invocations` is empty.

  Rendering nothing is not an option — issue #16 asks for this explicitly, and a
  blank card on the proof screen reads as a broken product rather than as a Call
  where nothing happened.

  Five situations, five sentences. The order of the checks below is the whole
  design: each one is only reached because the ones above it did not apply.
*/

export type NoToolsInput = {
  callStatus: CallStatus;
  /** From the Appointment, so the sentence names a person rather than "the caller". */
  personName: string;
  extraction: {
    status: ExtractionStatus;
    inVoicemail: boolean | null;
    confirmed: boolean | null;
    newTime: string | null;
  } | null;
};

export type NoToolsSummary = {
  headline: string;
  detail: string;
};

export function noToolsSummary({
  callStatus,
  personName,
  extraction,
}: NoToolsInput): NoToolsSummary {
  /*
    First, because it explains every other emptiness on the screen at once. A
    Call that never connected has no transcript, no recording and no
    invocations, and the failure card above already carries the reason.
  */
  if (callStatus !== "completed") {
    return {
      headline: "Nothing to do — the call did not connect",
      detail:
        "Maya never got as far as the conversation, so she did nothing. The reason is in the card above.",
    };
  }

  if (extraction === null) {
    return {
      headline: "Maya did nothing on this call",
      detail: `The call is still being written up, so there is nothing yet to say about what ${personName} agreed to.`,
    };
  }

  if (extraction.status === "failed") {
    return {
      headline: "Maya did nothing on this call",
      detail:
        "And the write-up failed, so nothing has been pieced together from the transcript either. What the model actually said is in the amber card below.",
    };
  }

  // Measured on the line itself; nothing infers it (SPEC.md §9 step 4).
  if (extraction.inVoicemail === true) {
    return {
      headline: "A machine picked up",
      detail: `The line reported voicemail, so there was nobody to book with. ${personName}'s appointment is untouched.`,
    };
  }

  /*
    Above `confirmed`, matching `fallbackChange` in lib/extraction/outcome.ts.
    Somebody who named a new time did not agree to the old one, whatever else
    came back in the same object — and the two files disagreeing would put
    "confirmed" on this card about an Appointment the extraction moved to Needs
    Attention.
  */
  if (extraction.newTime !== null) {
    return {
      headline: `${personName} asked for a different time`,
      detail: `Heard as "${extraction.newTime}". It is not booked — Maya never booked anything, and a time said out loud is not a slot in the diary. The appointment is waiting for someone to deal with.`,
    };
  }

  if (extraction.confirmed === true) {
    return {
      headline: `${personName} confirmed, but Maya did not record it`,
      detail:
        "This comes from reading the transcript afterwards rather than from anything Maya did on the call. The appointment was moved on the strength of it.",
    };
  }

  if (extraction.confirmed === false) {
    return {
      headline: `${personName} declined, but Maya did not record it`,
      detail:
        "This comes from reading the transcript afterwards rather than from anything Maya did on the call. The appointment was moved on the strength of it.",
    };
  }

  return {
    headline: "Nothing was decided",
    detail: `Maya spoke to ${personName}, did nothing, and reading the transcript afterwards turned up nothing to act on either. The appointment is unchanged.`,
  };
}
