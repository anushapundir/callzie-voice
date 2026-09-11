import { SENTIMENTS, type Sentiment } from "@/lib/db/schema";

/*
  Reading what the model sent back.

  Null means malformed, and malformed is what buys the one retry in run.ts
  (SPEC.md §9 step 5). Nothing here throws: the caller's job is to decide
  between retrying and recording a failure, and an exception would take that
  decision away from it.

  Lenient about a key being absent, strict about its type. `output_config.format`
  already constrains the shape at the API level (docs/verification.md A11), so a
  wrong type here means the constraint did not hold — which is exactly the case
  worth spending a second call on.

  `summary` is the one required field. Without it, `{}` would parse as a
  perfectly good answer full of nulls, and the retry would never fire on a model
  that returned nothing at all.
*/

export type ExtractionResult = {
  notes: string | null;
  summary: string;
  sentiment: Sentiment | null;
  /** Fallback only. Applied solely when no Tool committed — see outcome.ts. */
  confirmed: boolean | null;
  /** Fallback only, and free text. Never parsed into a Slot (design doc, decision 1). */
  newTime: string | null;
};

export function parseExtraction(raw: string): ExtractionResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  // `typeof [] === "object"`, so the array check is not redundant — the same
  // reasoning as lib/webhooks/payload.ts.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const object = parsed as Record<string, unknown>;

  const summary = optionalText(object.summary);
  if (summary === INVALID || summary === null) return null;

  const notes = optionalText(object.notes);
  if (notes === INVALID) return null;

  const newTime = optionalText(object.new_time);
  if (newTime === INVALID) return null;

  const sentiment = optionalSentiment(object.sentiment);
  if (sentiment === INVALID) return null;

  const confirmed = optionalBoolean(object.confirmed);
  if (confirmed === INVALID) return null;

  return { notes, summary, sentiment, confirmed, newTime };
}

/** Distinct from `null`, which is a legitimate value for every field but `summary`. */
const INVALID = Symbol("invalid");
type Invalid = typeof INVALID;

/**
 * A string, null, or invalid.
 *
 * An empty string becomes null. The model has no way to say "no notes" other
 * than `""` or `null`, and treating those two differently would put an empty
 * string in a column whose null already means the same thing.
 */
function optionalText(value: unknown): string | null | Invalid {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return INVALID;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function optionalSentiment(value: unknown): Sentiment | null | Invalid {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return INVALID;
  return SENTIMENTS.includes(value as Sentiment)
    ? (value as Sentiment)
    : INVALID;
}

function optionalBoolean(value: unknown): boolean | null | Invalid {
  if (value === undefined || value === null) return null;
  return typeof value === "boolean" ? value : INVALID;
}
