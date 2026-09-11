import { describe, expect, it } from "vitest";

import { parseExtraction } from "@/lib/extraction/parse";

/*
  What counts as an answer.

  `null` from this function means "malformed", and malformed is what buys the
  one retry in run.ts. So the line between null and a result is the line between
  paying for a second call and not — worth pinning down precisely.
*/

const GOOD = JSON.stringify({
  notes: "Wants a text reminder the day before.",
  summary: "Priya confirmed her Thursday appointment.",
  sentiment: "positive",
  confirmed: true,
  new_time: null,
});

describe("parseExtraction", () => {
  it("reads a complete answer", () => {
    expect(parseExtraction(GOOD)).toEqual({
      notes: "Wants a text reminder the day before.",
      summary: "Priya confirmed her Thursday appointment.",
      sentiment: "positive",
      confirmed: true,
      newTime: null,
    });
  });

  it("reads an answer wrapped in whitespace", () => {
    expect(parseExtraction(`\n  ${GOOD}\n`)?.confirmed).toBe(true);
  });

  it("treats an absent optional key as null", () => {
    const result = parseExtraction(
      JSON.stringify({ summary: "She did not pick up." }),
    );
    expect(result).toEqual({
      notes: null,
      summary: "She did not pick up.",
      sentiment: null,
      confirmed: null,
      newTime: null,
    });
  });

  it("treats an empty string as null", () => {
    const result = parseExtraction(
      JSON.stringify({ summary: "Fine.", notes: "", new_time: "" }),
    );
    expect(result?.notes).toBeNull();
    expect(result?.newTime).toBeNull();
  });

  it("rejects a truncated object", () => {
    expect(parseExtraction('{"summary": "She confir')).toBeNull();
  });

  it("rejects prose that is not JSON at all", () => {
    expect(parseExtraction("Sure! Here is the JSON you asked for.")).toBeNull();
  });

  it("rejects a JSON array", () => {
    expect(parseExtraction('[{"summary": "Fine."}]')).toBeNull();
  });

  it("rejects an empty object, because the summary is missing", () => {
    expect(parseExtraction("{}")).toBeNull();
  });

  it("rejects a summary that is not a string", () => {
    expect(parseExtraction('{"summary": 42}')).toBeNull();
  });

  it("rejects a sentiment outside the three", () => {
    expect(
      parseExtraction('{"summary": "Fine.", "sentiment": "grumpy"}'),
    ).toBeNull();
  });

  it("rejects a confirmed that is a string rather than a boolean", () => {
    expect(
      parseExtraction('{"summary": "Fine.", "confirmed": "yes"}'),
    ).toBeNull();
  });

  it("ignores a key nobody asked for", () => {
    const result = parseExtraction(
      JSON.stringify({ summary: "Fine.", call_successful: true }),
    );
    expect(result?.summary).toBe("Fine.");
  });
});
