import Retell from "retell-sdk";

/*
  The only place RETELL_API_KEY is read.

  Unlike lib/db/index.ts this does not throw at module import: the Agent creation
  script has modes that need no key at all (--offline renders the prompts and Tool
  schemas for review), and a top-level throw would make those unusable on a
  machine that has never had Retell credentials. The check moves into the factory,
  which only the paths that actually call Retell reach.
*/

export function retellClient(): Retell {
  const apiKey = process.env.RETELL_API_KEY;

  if (!apiKey) {
    throw new Error(
      "RETELL_API_KEY is not set. Copy .env.example to .env.local and paste the " +
        "key from https://dashboard.retellai.com/ — or run with --offline to " +
        "review the prompts and Tool schemas without contacting Retell.",
    );
  }

  return new Retell({ apiKey });
}
