import { describe, expect, it } from "vitest";

import { BUSINESS_TYPES, OUTBOUND_TOOL_NAMES } from "@/lib/db/schema";
import {
  PROMPT_VARIABLES,
  TEMPLATES,
  agentNameFor,
  buildPrompt,
  estimateTokens,
  templateFor,
} from "@/lib/retell/templates";
import { customTools, END_CALL_TOOL } from "@/lib/retell/tools";

describe("the four Templates", () => {
  it("covers every Business Type, in order", () => {
    expect(TEMPLATES.map((t) => t.businessType)).toEqual([...BUSINESS_TYPES]);
  });

  it("derives a stable, Retell-legal agent name for each", () => {
    for (const template of TEMPLATES) {
      expect(template.agentName).toBe(agentNameFor(template.businessType));
      // Retell: a-z, A-Z, 0-9, underscores and dashes, max 64, no spaces.
      expect(template.agentName).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });

  it("gives every Template a distinct agent name", () => {
    const names = TEMPLATES.map((t) => t.agentName);

    expect(new Set(names).size).toBe(names.length);
  });

  it("speaks in one voice", () => {
    // CONTEXT.md names a single Agent, Maya. Only her words vary by Template.
    expect(new Set(TEMPLATES.map((t) => t.voiceId)).size).toBe(1);
  });
});

/*
  The heart of "four Templates cost four strings, not four pipelines" (SPEC.md §4).

  Render every Template with the same sentinel deltas and the output must be
  byte-identical. If buildPrompt ever reads anything off a Template beyond the
  three declared holes, these diverge and this fails — which is what stops the
  four prompts drifting into four separately-maintained copies.
*/
describe("one structure, four Templates", () => {
  const SENTINELS = {
    businessNoun: "<BUSINESS_NOUN>",
    serviceNoun: "<SERVICE_NOUN>",
    inventionGuard: "<INVENTION_GUARD>",
  };

  it("varies only the three declared holes", () => {
    const structure = buildPrompt({ ...TEMPLATES[0], ...SENTINELS });

    for (const template of TEMPLATES) {
      expect(buildPrompt({ ...template, ...SENTINELS })).toBe(structure);
    }
  });

  it("actually fills those holes differently", () => {
    // Guards against the test above passing because buildPrompt ignores the
    // deltas entirely.
    const prompts = TEMPLATES.map(buildPrompt);

    expect(new Set(prompts).size).toBe(TEMPLATES.length);
  });
});

describe("every prompt", () => {
  /*
    The two acceptance criteria that exist because of SPEC.md §3 rule 7 — the
    most damaging failure available to this product is Maya confidently claiming
    a booking that never happened.
  */
  it.each(TEMPLATES)("$businessType never invents a time", (template) => {
    const prompt = buildPrompt(template);

    expect(prompt).toContain("Only ever offer times that");
    expect(prompt).toContain("check_availability returned");
    expect(prompt).toContain("never invent one");
  });

  it.each(TEMPLATES)("$businessType never claims a failed booking", (template) => {
    const prompt = buildPrompt(template);

    expect(prompt).toContain("If book_slot fails");
    expect(prompt).toContain("never say the booking is done");
  });

  it.each(TEMPLATES)("$businessType knows what to do when nothing is open", (template) => {
    // check_availability can return an empty list — a full fortnight, or a Call
    // that has worked through everything in it. Without a branch she improvises
    // one, and the improvised version invents a time.
    const prompt = buildPrompt(template);

    expect(prompt).toContain("no times at all");
    expect(prompt).toContain("someone will call them back");
  });

  it.each(TEMPLATES)("$businessType uses the words a Tool hands it", (template) => {
    // lib/tools/say.ts owns the sentence for every outcome that matters. This
    // line is the prompt-side half of that, and it is a suggestion — which is
    // why the response itself is unambiguous without it.
    expect(buildPrompt(template)).toContain("includes a say value");
  });

  it.each(TEMPLATES)("$businessType books before it speaks", (template) => {
    /*
      A live Call on 2026-08-21 ended with "I'll book Monday at 12:30, I'm
      placing a hold for that time now" and no book_slot invocation at all. An
      announced intention is indistinguishable, down a phone line, from an
      announced result.
    */
    const prompt = buildPrompt(template);

    expect(prompt).toContain("call book_slot straight away");
    expect(prompt).toContain("Do not say you are");
    expect(prompt).toContain("until book_slot has answered");
  });

  it.each(TEMPLATES)("$businessType names every Tool it may call", (template) => {
    const prompt = buildPrompt(template);

    /*
      The outbound four, not all of `TOOL_NAMES`. Issue #43 added three inbound
      Tools, and this Agent is never given them — naming `book_appointment` in a
      confirmation call's prompt would describe a Tool the Agent does not hold.
    */
    for (const tool of OUTBOUND_TOOL_NAMES) {
      expect(prompt).toContain(tool);
    }
  });

  it.each(TEMPLATES)("$businessType names no inbound Tool", (template) => {
    // The other half of the rule above, and the one that actually catches the
    // mistake: a prompt that mentions a Tool the Agent cannot call is an
    // instruction to attempt something that will silently do nothing.
    const prompt = buildPrompt(template);

    expect(prompt).not.toContain("book_appointment");
    expect(prompt).not.toContain("log_enquiry");
    expect(prompt).not.toContain("lookup_appointment");
  });

  it.each(TEMPLATES)("$businessType carries its invention guard", (template) => {
    expect(buildPrompt(template)).toContain(template.inventionGuard);
  });

  /*
    Business Hours and the call cap are enforced in the Tool and in config, never
    in the prompt (SPEC.md §3 rule 6). A4's older sample prompt said "End the call
    within 90 seconds"; this asserts that habit did not come back.
  */
  it.each(TEMPLATES)("$businessType states no time limit", (template) => {
    const prompt = buildPrompt(template);

    expect(prompt).not.toMatch(/\d+\s*seconds/i);
    expect(prompt).not.toMatch(/business hours/i);
  });
});

describe("dynamic variables", () => {
  it.each(TEMPLATES)("$businessType uses only the known set", (template) => {
    const used = new Set(
      [...buildPrompt(template).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]),
    );

    expect([...used].sort()).toEqual([...PROMPT_VARIABLES].sort());
  });

  it.each(TEMPLATES)("$businessType avoids reserved names", (template) => {
    // first_name is reserved and auto-populates from Retell Contacts
    // (docs/verification.md A5) — shadowing it is a silent wrong-name bug.
    expect(buildPrompt(template)).not.toContain("first_name");
  });

  /*
    The begin message is the literal first utterance, spoken before any turn can
    go wrong. Retell does support variables there, but an unset one renders
    literally, so a plumbing bug would open the demo with "Hi, this is Maya
    calling from curly-curly-business_name". Step 1 of the prompt greets by name
    a beat later, so the variable buys almost nothing at the worst moment.
  */
  it.each(TEMPLATES)("$businessType opens with fixed words", (template) => {
    expect(template.beginMessage.length).toBeGreaterThan(0);
    expect(template.beginMessage).not.toContain("{{");
  });
});

/*
  Retell scales billed duration for agents over 4,000 prompt tokens
  (docs/verification.md A2). Whether Retell counts tool descriptions and schemas
  toward that is undocumented, so everything sent to the Response Engine is
  counted here. The assertion is half the budget, so "well under" is what fails
  rather than merely "over".
*/
describe("the token budget", () => {
  const BUDGET = 2000;

  function totalTokens(template: (typeof TEMPLATES)[number]): number {
    const tools = customTools("https://callzie.example.test", "secret");

    const toolText = [...tools, END_CALL_TOOL]
      .map((tool) => JSON.stringify(tool))
      .join("");

    return estimateTokens(
      buildPrompt(template) + template.beginMessage + toolText,
    );
  }

  it.each(TEMPLATES)("$businessType stays well under 4,000", (template) => {
    expect(totalTokens(template)).toBeLessThan(BUDGET);
  });

  it("over-estimates rather than under-estimates", () => {
    // ~4 chars/token is the English rule of thumb; /3 must be the pessimistic side.
    expect(estimateTokens("a".repeat(120))).toBeGreaterThan(30);
  });
});

describe("templateFor", () => {
  it("finds every Business Type", () => {
    for (const businessType of BUSINESS_TYPES) {
      expect(templateFor(businessType).businessType).toBe(businessType);
    }
  });
});
