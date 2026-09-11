/*
  The four transcripts of SPEC.md §10, against the real Claude Haiku.

  Why this exists on top of the test suite. `lib/extraction/run.test.ts` injects
  a fake model, so it proves the pipeline: the retry, the soft failure, the rule
  that a Tool wins. It cannot tell you whether a real model understands what it
  is being asked — which is the other half of the acceptance criterion, and the
  only thing this script checks.

  Run it when you change the prompt:

    npm run try-extraction

  No database, no Call, no webhook, no telephony. About $0.0016 a transcript
  (docs/verification.md A11), so roughly two-thirds of a cent for the set.
*/

import { readFileSync } from "node:fs";

import { config } from "dotenv";

// Next loads .env.local itself; a plain Node process does not. Same mechanism
// and same reason as scripts/replay-webhook.ts. It has to run before anything
// below reads process.env.
config({ path: ".env.local" });

import { anthropicExtractor } from "@/lib/extraction/llm";
import { parseExtraction } from "@/lib/extraction/parse";
import { extractionPrompt, STRICTER_NUDGE } from "@/lib/extraction/prompt";

/** What each transcript should produce, so a wrong answer is obvious on sight. */
const CASES = [
  { name: "confirm", expect: "confirmed: true, no new_time" },
  { name: "reschedule", expect: "new_time set, confirmed not true" },
  { name: "decline", expect: "confirmed: false, no new_time" },
  { name: "voicemail", expect: "confirmed: null — nobody answered" },
] as const;

/*
  The same fixture lib/tools/testing.ts seeds, so the prompt this script renders
  is the one the tests render. A different name or time here would be testing a
  prompt nothing else uses.
*/
const PERSON = "Priya Sharma";
const SPOKEN_TIME = "Thursday 20 August at 2:30 PM";

async function main() {
  const llm = anthropicExtractor();
  let unreadable = 0;

  for (const { name, expect } of CASES) {
    const transcript = readFileSync(`fixtures/transcripts/${name}.txt`, "utf8");
    const prompt = extractionPrompt({
      transcript,
      personName: PERSON,
      appointmentSpokenTime: SPOKEN_TIME,
    });

    let response = await llm(prompt);
    let result =
      response.stopReason === "end_turn" ? parseExtraction(response.raw) : null;

    // The same single retry run.ts allows, so this exercises that path too.
    if (!result) {
      console.log(`  (retrying ${name} — the first answer could not be read)`);
      response = await llm(`${prompt}\n${STRICTER_NUDGE}`);
      result =
        response.stopReason === "end_turn" ? parseExtraction(response.raw) : null;
    }

    console.log(`\n=== ${name} ===`);
    console.log(`expected:  ${expect}`);

    if (!result) {
      unreadable += 1;
      console.log(`UNREADABLE (stop_reason: ${response.stopReason})`);
      console.log(response.raw);
      continue;
    }

    console.log(`confirmed: ${result.confirmed}`);
    console.log(`new_time:  ${result.newTime}`);
    console.log(`sentiment: ${result.sentiment}`);
    console.log(`summary:   ${result.summary}`);
    console.log(`notes:     ${result.notes}`);
  }

  console.log(
    `\n${CASES.length - unreadable}/${CASES.length} transcripts read. ` +
      `Judge the values against the expected line above each — this script ` +
      `checks that the model answered, not that it answered well.`,
  );

  if (unreadable > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
