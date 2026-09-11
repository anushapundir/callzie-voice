import Anthropic from "@anthropic-ai/sdk";

import { EXTRACTION_SCHEMA } from "@/lib/extraction/prompt";

/*
  The Anthropic call, and the seam that keeps it out of every test.

  `run.ts` depends on `ExtractionLlm` — a function — and never on this file's
  implementation. That is not ceremony: it is what makes the four transcripts
  testable with no API key, no network and no cost, which is the whole of
  SPEC.md §10.

  It is also the shape this repo already uses everywhere it touches something
  external: `envStatus(env)`, `verifySignature(secret)`, `runTool({ handler })`.
  There is not one `vi.mock` in the codebase, and this does not add the first.

  Like lib/retell/client.ts, the key is read in the factory rather than at import
  — so prompt.ts and parse.ts stay importable on a machine that has never had
  Anthropic credentials.
*/

/** What the model sent back, before anyone tries to read it. */
export type LlmResponse = {
  /** Every text block, concatenated. Empty string if the response carried none. */
  raw: string;
  /** Anything but `end_turn` means the answer is not whole — see run.ts. */
  stopReason: string | null;
};

export type ExtractionLlm = (prompt: string) => Promise<LlmResponse>;

/** Claude Haiku 4.5 — docs/verification.md A11. ~$0.0016 per extraction. */
const MODEL = "claude-haiku-4-5";

/**
 * Enough for the five fields several times over, and short enough that a model
 * which starts rambling is cut off rather than billed for.
 */
const MAX_TOKENS = 1024;

export function anthropicExtractor(
  apiKey: string | undefined = process.env.ANTHROPIC_API_KEY,
): ExtractionLlm {
  if (!apiKey || apiKey.trim() === "") {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Copy .env.example to .env.local and paste " +
        "the key from https://console.anthropic.com/ — extraction is the only " +
        "thing that needs it, so Calls still run without it.",
    );
  }

  const client = new Anthropic({ apiKey: apiKey.trim() });

  return async (prompt: string): Promise<LlmResponse> => {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "user", content: prompt }],
      /*
        Constrains the response shape at the API level, which makes malformed
        JSON very unlikely — not impossible (docs/verification.md A11). The retry
        in run.ts stays.

        Cast because the SDK's published types trail this parameter; the wire
        contract is in A11. Note it is `output_config`, not the top-level
        `output_format`, which is deprecated API-wide.
      */
      output_config: {
        format: { type: "json_schema", schema: EXTRACTION_SCHEMA },
      },
    } as unknown as Anthropic.MessageCreateParamsNonStreaming);

    return {
      raw: response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(""),
      stopReason: response.stop_reason,
    };
  };
}
