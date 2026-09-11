import { describe, expect, it } from "vitest";

import {
  buildDynamicVariables,
  renderPromptVariables,
  validateDynamicVariables,
} from "@/lib/calls/dynamic-variables";
import { buildPrompt, PROMPT_VARIABLES, TEMPLATES } from "@/lib/retell/templates";

// 14:30 Asia/Kolkata on Tuesday 2026-08-18.
const STARTS_AT = new Date("2026-08-18T09:00:00.000Z");

function build() {
  return buildDynamicVariables({
    businessName: "Bandra Dental",
    name: "Priya Nair",
    serviceName: "Cleaning",
    startsAt: STARTS_AT,
    timezone: "Asia/Kolkata",
  });
}

describe("buildDynamicVariables", () => {
  it("produces exactly the keys the prompts expect", () => {
    expect(Object.keys(build()).sort()).toEqual([...PROMPT_VARIABLES].sort());
  });

  it("makes every value a string, because Retell rejects anything else", () => {
    // docs/verification.md A5: "All values in retell_llm_dynamic_variables must
    // be strings." A Date here fails at call time, not at build time.
    for (const value of Object.values(build())) {
      expect(typeof value).toBe("string");
    }
  });

  it("renders the time in the Business's own timezone", () => {
    // 09:00 UTC is 14:30 in Kolkata. Maya must say the customer's time, not ours.
    expect(build().time).toContain("2:30 PM");
  });

  it("writes the time to be spoken, not to be read in a table", () => {
    /*
      The bug this pins: `formatInZone` was reused here, and Maya read its
      dashboard format aloud as "Thu twenty Aug, fourteen thirty" on a real
      Call. Month and weekday must be words, and the clock must be 12-hour.
    */
    const { time } = build();

    expect(time).toBe("Tuesday 18 August at 2:30 PM");
    expect(time).not.toMatch(/\bAug\b(?!ust)/); // never the abbreviation
    expect(time).not.toMatch(/\bTue\b(?!sday)/);
    expect(time).not.toContain("14:30"); // never the 24-hour clock
  });
});

describe("validateDynamicVariables", () => {
  it("accepts a complete set", () => {
    expect(validateDynamicVariables(build())).toEqual({ ok: true });
  });

  it("names a missing key", () => {
    const vars = build();
    delete vars.name;
    expect(validateDynamicVariables(vars)).toEqual({
      ok: false,
      invalid: ["name"],
    });
  });

  it("rejects an empty string, which Retell replaces with nothing", () => {
    // Maya would say "your appointment on" and stop.
    expect(validateDynamicVariables({ ...build(), time: "" })).toEqual({
      ok: false,
      invalid: ["time"],
    });
  });

  it("rejects a value that is only whitespace", () => {
    expect(validateDynamicVariables({ ...build(), name: "   " })).toEqual({
      ok: false,
      invalid: ["name"],
    });
  });

  it("rejects a non-string value", () => {
    const vars = { ...build(), name: 42 } as unknown as Record<string, string>;
    expect(validateDynamicVariables(vars)).toEqual({
      ok: false,
      invalid: ["name"],
    });
  });

  it("names every problem at once", () => {
    expect(validateDynamicVariables({ ...build(), name: "", time: "" })).toEqual({
      ok: false,
      invalid: ["name", "time"],
    });
  });
});

describe("no placeholder ever reaches the caller", () => {
  /*
    Acceptance criterion 2. An unset variable renders literally, so a plumbing
    bug means Maya says "curly-curly-name" out loud to a customer
    (docs/verification.md A5). This proves it for every Template without
    placing a Call.
  */
  it.each(TEMPLATES.map((t) => [t.businessType, t] as const))(
    "leaves no double brace in the %s prompt or begin message",
    (_type, template) => {
      const vars = build();

      expect(renderPromptVariables(buildPrompt(template), vars)).not.toMatch(
        /\{\{|\}\}/,
      );
      expect(renderPromptVariables(template.beginMessage, vars)).not.toMatch(
        /\{\{|\}\}/,
      );
    },
  );

  it("would catch a prompt that referenced a variable nobody sends", () => {
    // The guard on the guard: if the sweep above could not fail, it would prove
    // nothing. A prompt naming an unknown variable must survive substitution.
    expect(renderPromptVariables("Hello {{nickname}}", build())).toContain(
      "{{nickname}}",
    );
  });
});
