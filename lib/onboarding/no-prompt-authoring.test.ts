import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * SPEC.md §14 rule 5 — "Never lets a user author an agent prompt. Four curated
 * Templates, no textarea" — asserted rather than reviewed.
 *
 * Unusual as a test, and deliberate. The repo has no component-test tooling
 * (`vitest.config.mts` runs in `node`, with no jsdom and no Playwright), so
 * without this the rule is only ever a promise someone has to remember at
 * review time. It is the same move `app/globals.css` already makes by resetting
 * Tailwind's scales — turning a review convention into something mechanical.
 *
 * The check is over source text, so it cannot prove the rendered DOM. What it
 * does catch is the realistic regression: someone adding a "customise your
 * agent" field to the onboarding flow because a customer asked for one.
 */

const SCANNED_DIRECTORIES = [
  "app/(onboarding)",
  "components/onboarding",
];

/** Editable surfaces. A Template is chosen, never written. */
const FORBIDDEN = [
  { pattern: /<textarea/i, what: "a textarea" },
  { pattern: /contentEditable/i, what: "a contenteditable element" },
  { pattern: /name=["'`]prompt["'`]/i, what: 'a field named "prompt"' },
  { pattern: /name=["'`]\w*[Pp]rompt\w*["'`]/, what: "a prompt-shaped field name" },
];

function sourceFilesIn(directory: string): string[] {
  const absolute = join(process.cwd(), directory);
  const found: string[] = [];

  for (const entry of readdirSync(absolute)) {
    const path = join(absolute, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFilesIn(join(directory, entry)));
    } else if (/\.tsx?$/.test(entry)) {
      found.push(path);
    }
  }

  return found;
}

describe("the onboarding flow offers no way to author an Agent prompt", () => {
  /*
    The directory walk happens inside the test, not at collection time.

    An earlier version built the file list at module scope and fed it to
    `it.each`. That made every assertion in this file depend on one `readdirSync`
    running during collection, so a transient filesystem error — a Windows file
    lock from a concurrent build, an indexer holding the tree — failed all eight
    tests at once with an error that pointed at the wrong thing. Doing the I/O
    where it is used keeps a failure to one test, and keeps the message about
    what actually broke.
  */
  it("finds the files it means to check", () => {
    // Without this, a renamed directory turns the whole check into a no-op that
    // passes forever.
    expect(SCANNED_DIRECTORIES.flatMap(sourceFilesIn).length).toBeGreaterThanOrEqual(4);
  });

  it("has no editable prompt surface in any scanned file", () => {
    const offences: string[] = [];

    for (const file of SCANNED_DIRECTORIES.flatMap(sourceFilesIn)) {
      const source = readFileSync(file, "utf8");
      for (const { pattern, what } of FORBIDDEN) {
        if (pattern.test(source)) offences.push(`${file} contains ${what}`);
      }
    }

    // Reported together: if someone adds a prompt field they have usually added
    // it to the form and the action in the same change.
    expect(offences).toEqual([]);
  });
});

describe("the app ships no Textarea primitive at all", () => {
  it("has no components/ui/textarea.tsx", () => {
    // `shadcn add command` pulls one in transitively, through input-group. It
    // is deleted on purpose: an unused Textarea in a product forbidden from
    // offering one is an invitation to exactly the wrong edit.
    const uiComponents = readdirSync(join(process.cwd(), "components/ui"));
    expect(uiComponents).not.toContain("textarea.tsx");
  });
});
