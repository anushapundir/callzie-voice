/*
  Everything that turns a stored Call into a transcript on screen.

  Two sources, one output. `calls.transcript_turns` holds Retell's
  `transcript_object` and carries a start time per turn; `calls.transcript`
  holds the plain text and carries none. This module owns both directions — the
  parser that reads Retell's shape on the way in, and the reader that turns
  either column into renderable turns on the way out — so the two can never
  drift into disagreeing about what a turn is.
*/

/** Which side of the conversation a turn belongs to. */
export type Speaker = "agent" | "person";

/**
 * One turn as it is stored in `calls.transcript_turns`.
 *
 * Retell's vocabulary, kept deliberately: `role` here is `agent` or `user`,
 * matching the payload, so a stored row can be read back against Retell's own
 * docs without a translation table. The translation to `Speaker` happens once,
 * on the way to the screen.
 *
 * The word-level timings Retell also sends are dropped. Nothing on this screen
 * highlights individual words, and keeping them would multiply the column's
 * size by roughly the word count for no reader.
 */
export type StoredTurn = {
  role: "agent" | "user";
  content: string;
  /** Seconds from the start of the recording, or null if Retell gave none. */
  startSeconds: number | null;
};

/** One turn as the screen renders it. */
export type TranscriptTurn = {
  speaker: Speaker;
  text: string;
  startSeconds: number | null;
};

export type CallTranscriptInput = {
  /** The `calls.transcript_turns` jsonb column, unvalidated. */
  transcriptTurns: unknown;
  /** The `calls.transcript` text column. */
  transcript: string | null;
};

/**
 * The transcript to render, from whichever column has one.
 *
 * Stamped turns win. The plain text is the fallback, and it is a permanent one
 * rather than a migration artefact — see the note at the top of
 * `lib/calls/transcript.test.ts`.
 */
export function callTranscript({
  transcriptTurns,
  transcript,
}: CallTranscriptInput): TranscriptTurn[] {
  const stored = readStoredTurns(transcriptTurns);
  if (stored && stored.length > 0) {
    return stored.map((turn) => ({
      speaker: turn.role === "agent" ? "agent" : "person",
      text: turn.content,
      startSeconds: turn.startSeconds,
    }));
  }

  return fromPlainText(transcript);
}

/**
 * Validate the jsonb column on the way back out.
 *
 * Anything unrecognised yields null, which means "we have no turns" and sends
 * the caller to the plain text. Same contract, and the same reasoning, as
 * `offeredSlotsInCall` in lib/tools/offers.ts: `result` and `transcript_turns`
 * are both jsonb, and a column an older version of this code wrote must not be
 * able to throw inside a page render.
 */
export function readStoredTurns(value: unknown): StoredTurn[] | null {
  if (!Array.isArray(value)) return null;

  const turns: StoredTurn[] = [];

  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;

    const { role, content, startSeconds } = entry as Record<string, unknown>;
    if (role !== "agent" && role !== "user") continue;
    if (typeof content !== "string" || content === "") continue;

    turns.push({
      role,
      content,
      startSeconds: typeof startSeconds === "number" ? startSeconds : null,
    });
  }

  return turns.length > 0 ? turns : null;
}

/**
 * Retell's `call.transcript_object`, read down to what this screen renders.
 *
 * The shape is an array of `{ role, content, words: [{ word, start, end }] }`
 * (docs/verification.md A9). A turn's start time is its first word's — that is
 * the moment the speaker began.
 *
 * Null on anything malformed rather than a thrown error, matching every other
 * reader in `lib/webhooks/payload.ts`. This runs inside the webhook handler, and
 * a surprising payload must cost us timestamps and never cost us the delivery.
 * Null sends the screen to the plain-text transcript, which is already there.
 */
export function parseTranscriptObject(value: unknown): StoredTurn[] | null {
  if (!Array.isArray(value)) return null;

  const turns: StoredTurn[] = [];

  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;

    const { role, content, words } = entry as Record<string, unknown>;
    if (role !== "agent" && role !== "user") continue;
    if (typeof content !== "string" || content === "") continue;

    turns.push({ role, content, startSeconds: firstWordStart(words) });
  }

  return turns.length > 0 ? turns : null;
}

function firstWordStart(words: unknown): number | null {
  if (!Array.isArray(words)) return null;

  for (const word of words) {
    if (typeof word !== "object" || word === null) continue;

    const { start } = word as Record<string, unknown>;
    if (typeof start === "number" && Number.isFinite(start)) return start;
  }

  return null;
}

/** Retell's own prefixes, exactly as they appear in `call.transcript`. */
const PREFIXES: ReadonlyArray<{ prefix: string; speaker: Speaker }> = [
  { prefix: "Agent:", speaker: "agent" },
  { prefix: "User:", speaker: "person" },
];

/**
 * Split `Agent: ...\nUser: ...` into turns.
 *
 * A line with no prefix joins the turn above it rather than being dropped. A
 * transcript missing a sentence is worse than an ugly one, and Retell does emit
 * wrapped lines. A line with no prefix and no turn above it has nowhere to go
 * and is dropped — it is preamble, not speech.
 */
function fromPlainText(transcript: string | null): TranscriptTurn[] {
  if (!transcript) return [];

  const turns: TranscriptTurn[] = [];

  for (const rawLine of transcript.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;

    const match = PREFIXES.find(({ prefix }) => line.startsWith(prefix));

    if (match) {
      turns.push({
        speaker: match.speaker,
        text: line.slice(match.prefix.length).trim(),
        startSeconds: null,
      });
      continue;
    }

    const previous = turns.at(-1);
    if (previous) previous.text = `${previous.text} ${line}`.trim();
  }

  return turns.filter((turn) => turn.text !== "");
}
