import { describe, expect, it } from "vitest";

import { INBOUND_TOOL_NAMES, OUTBOUND_TOOL_NAMES } from "@/lib/db/schema";
import {
  INBOUND_MAX_CALL_DURATION_MS,
  INBOUND_PROMPT_VARIABLES,
  TEMPLATES,
  buildInboundPrompt,
  inboundAgentNameFor,
  inboundBeginMessage,
} from "@/lib/retell/templates";
import { customTools, END_CALL_TOOL } from "@/lib/retell/tools";

/*
  The inbound Agent (issue #43).

  The outbound prompt has its own suite next door; this one exists because the
  inbound prompt carries the refusals in SPEC.md §14 rules 10 to 14, and every
  one of those is a way the feature can hurt somebody rather than merely
  disappoint them. A prompt instruction is only a suggestion (SPEC.md §3 rule 6)
  — but a suggestion that has been deleted is not even that, and these assertions
  are what notices the deletion.
*/

/*
  The prompt is hard-wrapped for reading, so "their full name" spans a newline
  and a naive `toContain` misses it. The model reads whitespace as whitespace,
  so collapsing it is testing what the prompt says rather than how it is laid
  out — and it means re-wrapping a paragraph never turns a safety test red for
  no reason.
*/
function said(template: (typeof TEMPLATES)[number]): string {
  return buildInboundPrompt(template).replace(/\s+/g, " ");
}

describe("the inbound Agent name", () => {
  it("is distinct from the outbound Agent for the same Business Type", () => {
    for (const template of TEMPLATES) {
      expect(inboundAgentNameFor(template.businessType)).not.toBe(
        template.agentName,
      );
    }
  });

  it("is Retell-legal", () => {
    for (const template of TEMPLATES) {
      // a-z, A-Z, 0-9, underscores and dashes, max 64, no spaces.
      expect(inboundAgentNameFor(template.businessType)).toMatch(
        /^[a-zA-Z0-9_-]{1,64}$/,
      );
    }
  });

  it("gives every Business Type its own", () => {
    const names = TEMPLATES.map((t) => inboundAgentNameFor(t.businessType));

    expect(new Set(names).size).toBe(names.length);
  });
});

describe("one structure, four inbound Templates", () => {
  const SENTINELS = {
    businessNoun: "<BUSINESS_NOUN>",
    serviceNoun: "<SERVICE_NOUN>",
    inventionGuard: "<INVENTION_GUARD>",
  };

  it("varies only the declared holes", () => {
    // Same discipline as the outbound prompt: four Templates cost four strings,
    // not four separately-maintained copies (SPEC.md §4).
    const structure = buildInboundPrompt({ ...TEMPLATES[0], ...SENTINELS });

    for (const template of TEMPLATES) {
      expect(buildInboundPrompt({ ...template, ...SENTINELS })).toBe(structure);
    }
  });

  it("actually fills them differently", () => {
    const prompts = TEMPLATES.map(buildInboundPrompt);

    expect(new Set(prompts).size).toBe(TEMPLATES.length);
  });

  it("does not use the service noun", () => {
    // An inbound caller has no appointment yet, so there is no noun for one.
    // Changing only `serviceNoun` must change nothing.
    const base = buildInboundPrompt(TEMPLATES[0]);
    const swapped = buildInboundPrompt({
      ...TEMPLATES[0],
      serviceNoun: "<SOMETHING_ELSE>",
    });

    expect(swapped).toBe(base);
  });
});

describe("every inbound prompt", () => {
  describe("SPEC.md §14 rule 10 — never gives medical, safety or legal advice", () => {
    /*
      The highest-risk path in the whole feature. An always-on clinic line
      receives "I'm in a lot of pain, what should I do?" in its first week, and
      the only acceptable answer is a real number and a hang-up.
    */
    it.each(TEMPLATES)("$businessType hands over an emergency", (template) => {
      const prompt = said(template);

      expect(prompt).toContain("emergency");
      expect(prompt).toContain("{{emergency_line}}");
      expect(prompt).toContain("cannot help with that");
    });

    it.each(TEMPLATES)("$businessType puts it first", (template) => {
      /*
        Ordering is the cheapest instruction an LLM follows, and everything else
        on the call is worthless if this is got wrong. If a later edit demotes
        this branch below the booking flow, this test is what says so.
      */
      const prompt = said(template);

      expect(prompt.indexOf("{{emergency_line}}")).toBeLessThan(
        prompt.indexOf("book_appointment"),
      );
    });
  });

  it.each(TEMPLATES)(
    "$businessType takes a name and a number before booking — rule 11",
    (template) => {
      // A Slot held for somebody unreachable is worse than an empty Slot: it
      // blocks a real booking and nobody can undo it.
      const prompt = said(template);

      expect(prompt).toContain("full name");
      expect(prompt).toContain("read the number back");
      expect(prompt.indexOf("full name")).toBeLessThan(
        prompt.indexOf("call book_appointment"),
      );
    },
  );

  it.each(TEMPLATES)("$businessType never quotes a price — rule 12", (template) => {
    const prompt = said(template);

    expect(prompt).toContain("Never quote a price");
    expect(prompt).toContain("covered by insurance");
  });

  it.each(TEMPLATES)("$businessType never takes payment — rule 13", (template) => {
    expect(said(template)).toContain(
      "Never take card or payment details",
    );
  });

  it.each(TEMPLATES)(
    "$businessType never promises a callback time — rule 14",
    (template) => {
      // "Someone will get back to you" is a promise Callzie can keep.
      // "Someone will call you at nine" is not.
      expect(said(template)).toContain(
        "Never promise that somebody will call back at a specific time",
      );
    },
  );

  it.each(TEMPLATES)("$businessType never invents a service", (template) => {
    // `services_list` is the whole of what Maya knows about what the business
    // does. Without this line she fills the gap with something plausible.
    const prompt = said(template);

    expect(prompt).toContain("{{services_list}}");
    expect(prompt).toContain("Never name a service that is not on it");
  });

  it.each(TEMPLATES)("$businessType never invents a time", (template) => {
    const prompt = said(template);

    expect(prompt).toContain("Only ever offer times that");
    expect(prompt).toContain("check_availability returned");
    expect(prompt).toContain("never invent one");
  });

  it.each(TEMPLATES)("$businessType never claims a failed booking", (template) => {
    // SPEC.md §3 rule 7 — the most damaging failure available to this product,
    // restated for the Tool that creates rather than moves.
    const prompt = said(template);

    expect(prompt).toContain("If book_appointment fails");
    expect(prompt).toContain("never say the booking is done");
  });

  it.each(TEMPLATES)("$businessType never narrates the write", (template) => {
    /*
      Identical to the outbound rule, for the identical reason: a live Call on
      2026-08-21 ended with Maya announcing a hold and the customer hanging up
      before the Tool ran. An announced intention is, to the person on the
      phone, an announced result.
    */
    expect(said(template)).toContain(
      "Do not say you are booking, holding or locking anything in",
    );
  });

  it.each(TEMPLATES)(
    "$businessType never guesses at an existing appointment",
    (template) => {
      // lookup_appointment matches on the calling number alone. "You're booked
      // for Tuesday" to somebody who is not is worse than "I can't find one".
      expect(said(template)).toContain(
        "Never guess that they have one",
      );
    },
  );

  it.each(TEMPLATES)("$businessType names every Tool it may call", (template) => {
    const prompt = said(template);

    for (const tool of INBOUND_TOOL_NAMES) {
      expect(prompt).toContain(tool);
    }
  });

  it.each(TEMPLATES)("$businessType names no outbound-only Tool", (template) => {
    /*
      The inbound Agent does not hold these, so naming one is an instruction to
      attempt something that silently does nothing. `check_availability` is
      shared and legitimately appears in both.
    */
    const prompt = said(template);
    const shared: readonly string[] = INBOUND_TOOL_NAMES;
    const outboundOnly = OUTBOUND_TOOL_NAMES.filter(
      (name) => !shared.includes(name),
    );

    for (const tool of outboundOnly) {
      expect(prompt).not.toContain(tool);
    }
  });

  it.each(TEMPLATES)("$businessType carries its invention guard", (template) => {
    expect(said(template)).toContain(template.inventionGuard);
  });

  it.each(TEMPLATES)("$businessType states no time or turn limit", (template) => {
    /*
      The call cap is config, never prompt (SPEC.md §3 rule 6). A prompt that
      says "keep it under five minutes" is a suggestion an LLM will cheerfully
      ignore, and it makes the real cap look negotiable.
    */
    const prompt = said(template);

    expect(prompt).not.toMatch(/\b\d+\s*(seconds|minutes)\b/);
    expect(prompt.toLowerCase()).not.toContain("within");
  });

  it.each(TEMPLATES)("$businessType uses only declared variables", (template) => {
    /*
      Retell renders an unset variable literally, so a typo is a sentence the
      caller hears — "curly-curly-buisness-name" (docs/verification.md A5).
    */
    const used = [...buildInboundPrompt(template).matchAll(/\{\{(\w+)\}\}/g)].map(
      (m) => m[1],
    );

    for (const name of used) {
      expect(INBOUND_PROMPT_VARIABLES).toContain(name);
    }
  });

  it.each(TEMPLATES)("$businessType discloses that it is an AI", (template) => {
    // Nearly half of consumers expect an AI voice to say so, and on a line the
    // business owns the disclosure is cheap and its absence is a liability.
    expect(inboundBeginMessage()).toContain("AI");
    expect(said(template)).toContain("AI assistant");
  });
});

describe("the inbound begin message", () => {
  it("is set, so Retell does not bill a dynamic opening", () => {
    // An unset begin_message triggers the 10-second billing minimum
    // (docs/verification.md A4).
    expect(inboundBeginMessage().length).toBeGreaterThan(0);
  });

  it("names the business, so the caller knows they dialled right", () => {
    expect(inboundBeginMessage()).toContain("{{business_name}}");
  });
});

describe("the inbound call cap", () => {
  it("is longer than the outbound one, and still a cap", () => {
    // An enquiry plus a booking is genuinely a longer conversation than a
    // confirmation. 180s cut a real booking off mid-negotiation once already.
    expect(INBOUND_MAX_CALL_DURATION_MS).toBe(300_000);
  });
});

describe("the inbound Tool set", () => {
  it("declares exactly the inbound Tools, plus end_call", () => {
    const tools = customTools("https://callzie.example", "secret", [
      ...INBOUND_TOOL_NAMES,
    ]);

    expect(tools.map((t) => t.name).sort()).toEqual([...INBOUND_TOOL_NAMES].sort());
    // end_call is not a Callzie Tool and is never recorded, but without it the
    // Agent physically cannot hang up and every Call runs to the cap.
    expect(END_CALL_TOOL.type).toBe("end_call");
  });

  it("never arms an inbound Agent with book_slot", () => {
    /*
      The security half of the split. `book_slot` resolves an Appointment from
      the Call, and an inbound Call has none — so this would be a Tool looking
      for a row that is not there, on a call with a stranger.
    */
    const tools = customTools("https://callzie.example", "secret", [
      ...INBOUND_TOOL_NAMES,
    ]);

    expect(tools.map((t) => t.name)).not.toContain("book_slot");
    expect(tools.map((t) => t.name)).not.toContain("cancel_appointment");
  });

  it("points every Tool at the deployed origin", () => {
    const tools = customTools("https://callzie.example", "secret", [
      ...INBOUND_TOOL_NAMES,
    ]);

    for (const tool of tools) {
      expect(tool.url.startsWith("https://callzie.example/api/tools/")).toBe(true);
    }
  });
});
