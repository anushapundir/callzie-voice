/*
  What the model is told, and what shape it may answer in.

  Pure, and deliberately separate from the client that sends it. The prompt is
  the thing most likely to be edited by hand, and `scripts/try-extraction.ts`
  needs to render it without holding an API key.

  Two things are NOT asked for. Voicemail comes from Retell's own
  `call_analysis.in_voicemail`, which is measured rather than inferred (SPEC.md
  §9 step 4). And nothing here asks the model to decide an outcome — `confirmed`
  and `new_time` record what the person said, and outcome.ts alone decides
  whether that is allowed to touch the Appointment.
*/

export type ExtractionInput = {
  transcript: string;
  personName: string;
  /** Already rendered in the Business's timezone, the way Maya said it aloud. */
  appointmentSpokenTime: string;
};

/**
 * The JSON schema handed to `output_config.format`.
 *
 * Every field is required and the object is closed, so "the model left it out"
 * is not a shape the parser has to reason about — an unanswerable field comes
 * back as an explicit null instead. See docs/verification.md A11.
 */
export const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    notes: {
      type: ["string", "null"],
      description:
        "Anything the person said that a receptionist would write down. Null if nothing.",
    },
    summary: {
      type: "string",
      description: "One or two lines describing how the call went.",
    },
    sentiment: {
      /*
        `enum` alone, with no `type` beside it.

        Written as `type: ["string", "null"]` plus this enum, the API refuses the
        whole request: "Enum value 'positive' does not match declared type
        '['string', 'null']'". Its validator checks each enum member against the
        declared type and does not accept a union there. The enum already pins
        the value to one of four things, three strings and a null, so the type
        line was saying nothing the enum did not.

        Only this field is affected. `notes`, `new_time` and `confirmed` keep
        their union types, because none of them carries an enum.
      */
      enum: ["positive", "neutral", "negative", null],
      description: "How the person sounded about the call overall.",
    },
    confirmed: {
      type: ["boolean", "null"],
      description:
        "True if the person agreed to keep the appointment, false if they refused it outright, null if neither was said.",
    },
    new_time: {
      type: ["string", "null"],
      description:
        "The new time the person asked for, in their own words. Null unless they named one.",
    },
  },
  required: ["notes", "summary", "sentiment", "confirmed", "new_time"],
  additionalProperties: false,
} as const;

export function extractionPrompt({
  transcript,
  personName,
  appointmentSpokenTime,
}: ExtractionInput): string {
  return `You are reading the transcript of a phone call an appointment-reminder assistant made on behalf of a small business.

The person called is ${personName}. Their appointment is currently booked for ${appointmentSpokenTime}.

Read the transcript and report what was said. Do not guess at anything that was not said — every field may be null.

- notes: anything worth writing down. A preference, a reason, a phone number, a request. Not a retelling of the call.
- summary: one or two lines, in plain English.
- sentiment: how the person sounded — positive, neutral or negative.
- confirmed: true only if the person clearly agreed to keep the appointment as booked. False only if they clearly refused it. Null if the call never got there.
- new_time: the time they asked to move to, in their own words ("Friday morning", "same time next week"). Null unless they named one. If they named a new time, set confirmed to null rather than false — wanting a different time is not the same as refusing the appointment.

Transcript:
${transcript}`;
}

/**
 * The whole of the retry (SPEC.md §9 step 5).
 *
 * Appended to the same prompt rather than replacing it, so the retry asks the
 * same question a second time, more firmly — not a different question whose
 * answer would mean something else.
 */
export const STRICTER_NUDGE = `
Your previous response could not be read. Return only valid JSON matching the schema. No explanation, no markdown fence, no text before or after the object.`;
