import { describe, expect, it } from "vitest";

import {
  EXTRACTION_SCHEMA,
  extractionPrompt,
  STRICTER_NUDGE,
} from "@/lib/extraction/prompt";

const INPUT = {
  transcript: "Agent: Hello Priya.\nUser: Yes, Thursday works.",
  personName: "Priya Sharma",
  appointmentSpokenTime: "Thursday 20 August at 2:30 PM",
};

describe("extractionPrompt", () => {
  it("includes the transcript verbatim", () => {
    expect(extractionPrompt(INPUT)).toContain(INPUT.transcript);
  });

  it("tells the model who was called and when the appointment is", () => {
    const prompt = extractionPrompt(INPUT);
    expect(prompt).toContain("Priya Sharma");
    expect(prompt).toContain("Thursday 20 August at 2:30 PM");
  });

  it("says confirmed and new_time describe what was said", () => {
    expect(extractionPrompt(INPUT)).toContain("new_time");
  });
});

describe("EXTRACTION_SCHEMA", () => {
  it("declares exactly the five fields the extractions table holds", () => {
    expect(Object.keys(EXTRACTION_SCHEMA.properties).sort()).toEqual([
      "confirmed",
      "new_time",
      "notes",
      "sentiment",
      "summary",
    ]);
  });

  it("closes the object, so the model cannot invent a sixth", () => {
    expect(EXTRACTION_SCHEMA.additionalProperties).toBe(false);
  });

  it("requires every field, so absence is never how the model answers", () => {
    // Copied before sorting: `as const` makes `required` a readonly tuple, and
    // readonly arrays have no `.sort()`.
    expect([...EXTRACTION_SCHEMA.required].sort()).toEqual([
      "confirmed",
      "new_time",
      "notes",
      "sentiment",
      "summary",
    ]);
  });

  it("constrains sentiment to the three the schema union allows", () => {
    expect([...EXTRACTION_SCHEMA.properties.sentiment.enum]).toEqual([
      "positive",
      "neutral",
      "negative",
      null,
    ]);
  });
});

describe("STRICTER_NUDGE", () => {
  it("is a non-empty instruction, since it is the whole of the retry", () => {
    expect(STRICTER_NUDGE.length).toBeGreaterThan(0);
  });
});
