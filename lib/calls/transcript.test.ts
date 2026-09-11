import { describe, expect, it } from "vitest";

import { callTranscript, parseTranscriptObject } from "@/lib/calls/transcript";

/*
  The fallback path, which is not only for rows written before
  `transcript_turns` existed.

  `call_ended` carries the text transcript and `call_analyzed` carries the
  object, minutes apart (docs/verification.md A9). So every Call has a real
  window in which the plain text is the only transcript there is, and this is
  what renders during it.
*/

const CONFIRM = [
  "Agent: Hi Priya, this is Maya from Bloom Salon.",
  "User: Hello.",
  "Agent: Does Thursday at nine still work?",
  "User: Yes, that's fine.",
].join("\n");

describe("callTranscript, from the plain text", () => {
  it("splits Agent and User lines into two-sided turns", () => {
    const turns = callTranscript({ transcriptTurns: null, transcript: CONFIRM });

    expect(turns).toHaveLength(4);
    expect(turns[0]).toEqual({
      speaker: "agent",
      text: "Hi Priya, this is Maya from Bloom Salon.",
      startSeconds: null,
    });
    expect(turns[1].speaker).toBe("person");
  });

  it("leaves every turn unstamped rather than guessing a time", () => {
    const turns = callTranscript({ transcriptTurns: null, transcript: CONFIRM });

    expect(turns.every((turn) => turn.startSeconds === null)).toBe(true);
  });

  it("joins an unprefixed line onto the turn above it", () => {
    const turns = callTranscript({
      transcriptTurns: null,
      transcript: "Agent: One sentence.\nAnd its continuation.\nUser: Fine.",
    });

    expect(turns).toHaveLength(2);
    expect(turns[0].text).toBe("One sentence. And its continuation.");
  });

  it("drops an unprefixed line that has no turn to join", () => {
    const turns = callTranscript({
      transcriptTurns: null,
      transcript: "Stray opening line.\nAgent: Hello.",
    });

    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("Hello.");
  });

  it("ignores blank lines and trailing newlines", () => {
    const turns = callTranscript({
      transcriptTurns: null,
      transcript: "Agent: Hello.\n\nUser: Hi.\n",
    });

    expect(turns).toHaveLength(2);
  });

  it("returns nothing for a Call with no transcript at all", () => {
    expect(callTranscript({ transcriptTurns: null, transcript: null })).toEqual([]);
    expect(callTranscript({ transcriptTurns: null, transcript: "" })).toEqual([]);
  });
});

/*
  Retell's shape, from docs/verification.md A9: an array of
  `{ role, content, words: [{ word, start, end }] }`. A turn's start time is its
  first word's, because that is when the person began speaking.

  Null on anything malformed, never a throw. This runs inside the webhook
  handler, and #13's whole design is that a surprising payload costs us a field
  and never costs us the delivery.
*/

const RETELL_OBJECT = [
  {
    role: "agent",
    content: "Hi Priya, this is Maya.",
    words: [
      { word: "Hi", start: 0.4, end: 0.6 },
      { word: "Priya,", start: 0.6, end: 0.9 },
    ],
  },
  {
    role: "user",
    content: "Hello.",
    words: [{ word: "Hello.", start: 3.2, end: 3.6 }],
  },
];

describe("parseTranscriptObject", () => {
  it("takes each turn's start time from its first word", () => {
    expect(parseTranscriptObject(RETELL_OBJECT)).toEqual([
      { role: "agent", content: "Hi Priya, this is Maya.", startSeconds: 0.4 },
      { role: "user", content: "Hello.", startSeconds: 3.2 },
    ]);
  });

  it("keeps a turn that has no words, unstamped", () => {
    expect(parseTranscriptObject([{ role: "agent", content: "Hello." }])).toEqual([
      { role: "agent", content: "Hello.", startSeconds: null },
    ]);
  });

  it("skips a turn whose role is not one Retell documents", () => {
    const parsed = parseTranscriptObject([
      { role: "system", content: "Ignore me." },
      { role: "user", content: "Keep me." },
    ]);

    expect(parsed).toEqual([
      { role: "user", content: "Keep me.", startSeconds: null },
    ]);
  });

  it("returns null rather than throwing on anything that is not an array", () => {
    expect(parseTranscriptObject(undefined)).toBeNull();
    expect(parseTranscriptObject(null)).toBeNull();
    expect(parseTranscriptObject("Agent: hello")).toBeNull();
    expect(parseTranscriptObject({ turns: [] })).toBeNull();
  });

  it("returns null when nothing in the array survives validation", () => {
    expect(parseTranscriptObject([{ role: "system", content: "x" }])).toBeNull();
    expect(parseTranscriptObject([])).toBeNull();
  });
});

describe("callTranscript, from the stored turns", () => {
  it("prefers the stamped turns over the plain text", () => {
    const turns = callTranscript({
      transcriptTurns: parseTranscriptObject(RETELL_OBJECT),
      transcript: "Agent: Something else entirely.",
    });

    expect(turns).toEqual([
      { speaker: "agent", text: "Hi Priya, this is Maya.", startSeconds: 0.4 },
      { speaker: "person", text: "Hello.", startSeconds: 3.2 },
    ]);
  });

  it("falls back to the plain text when the column holds something unusable", () => {
    const turns = callTranscript({
      transcriptTurns: { not: "an array" },
      transcript: "Agent: Hello.",
    });

    expect(turns).toEqual([
      { speaker: "agent", text: "Hello.", startSeconds: null },
    ]);
  });
});
