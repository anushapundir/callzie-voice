import { describe, expect, it } from "vitest";

import { TEMPLATES, agentNameFor } from "@/lib/retell/templates";
import {
  type ExistingAgent,
  findOrphanedLlms,
  hasConflicts,
  planAgents,
} from "@/lib/retell/reconcile";

/** An agent in the workspace, backed by a Retell LLM, for the given Template. */
function provisioned(businessType: string, suffix = "1"): ExistingAgent {
  return {
    agentId: `agent_${businessType}_${suffix}`,
    agentName: `callzie-${businessType}`,
    llmId: `llm_${businessType}_${suffix}`,
  };
}

describe("planAgents", () => {
  it("creates all four in an empty workspace", () => {
    const plan = planAgents(TEMPLATES, []);

    expect(plan).toHaveLength(TEMPLATES.length);
    expect(plan.every((action) => action.kind === "create")).toBe(true);
  });

  /*
    The acceptance criterion, as an assertion: a second run of the script against
    a workspace it already provisioned creates nothing.
  */
  it("creates nothing on a re-run", () => {
    const existing = TEMPLATES.map((t) => provisioned(t.businessType));

    const plan = planAgents(TEMPLATES, existing);

    expect(plan.every((action) => action.kind === "update")).toBe(true);
    expect(plan.some((action) => action.kind === "create")).toBe(false);
  });

  it("updates in place, keeping the existing ids", () => {
    const [template] = TEMPLATES;
    const existing = [provisioned(template.businessType)];

    const [action] = planAgents([template], existing);

    expect(action).toEqual({
      kind: "update",
      template,
      agentId: `agent_${template.businessType}_1`,
      llmId: `llm_${template.businessType}_1`,
    });
  });

  it("ignores agents Callzie does not own", () => {
    const strangers: ExistingAgent[] = [
      { agentId: "agent_x", agentName: "my-other-bot", llmId: "llm_x" },
      { agentId: "agent_y", agentName: "callzie", llmId: "llm_y" },
      { agentId: "agent_z", agentName: "callzie-clinic-old", llmId: "llm_z" },
    ];

    const plan = planAgents(TEMPLATES, strangers);

    expect(plan.every((action) => action.kind === "create")).toBe(true);
  });

  /*
    Retell does not enforce unique agent names, so this is reachable — and it is
    the whole point of the word "silently" in the acceptance criterion.
  */
  it("refuses to guess when two agents share a name", () => {
    const [template] = TEMPLATES;
    const duplicates = [
      provisioned(template.businessType, "1"),
      provisioned(template.businessType, "2"),
    ];

    const [action] = planAgents([template], duplicates);

    expect(action.kind).toBe("conflict");
    expect(action).toMatchObject({
      agentIds: [
        `agent_${template.businessType}_1`,
        `agent_${template.businessType}_2`,
      ],
    });
  });

  it("creates nothing anywhere in a plan that has a conflict", () => {
    const [first] = TEMPLATES;
    const duplicates = [
      provisioned(first.businessType, "1"),
      provisioned(first.businessType, "2"),
    ];

    const plan = planAgents([first], duplicates);

    expect(hasConflicts(plan)).toBe(true);
    expect(plan.some((action) => action.kind === "create")).toBe(false);
  });

  it("relinks an agent that lost its Retell LLM", () => {
    const [template] = TEMPLATES;
    const orphanedAgent: ExistingAgent = {
      agentId: "agent_1",
      agentName: agentNameFor(template.businessType),
      llmId: null,
    };

    const [action] = planAgents([template], [orphanedAgent]);

    expect(action.kind).toBe("relink");
    // The agent id must survive — queued Calls and retell_agents rows point at it.
    expect(action).toMatchObject({ agentId: "agent_1" });
  });

  it("plans one action per Template, in order", () => {
    const plan = planAgents(TEMPLATES, []);

    expect(plan.map((action) => action.template.businessType)).toEqual(
      TEMPLATES.map((t) => t.businessType),
    );
  });

  it("treats a partly-provisioned workspace one Template at a time", () => {
    const existing = [provisioned(TEMPLATES[0].businessType)];

    const plan = planAgents(TEMPLATES, existing);

    expect(plan[0].kind).toBe("update");
    expect(plan.slice(1).every((action) => action.kind === "create")).toBe(true);
  });
});

describe("hasConflicts", () => {
  it("is false for a clean plan", () => {
    expect(hasConflicts(planAgents(TEMPLATES, []))).toBe(false);
  });
});

describe("findOrphanedLlms", () => {
  /*
    A crash between creating the Response Engine and creating the Agent leaves an
    LLM nothing points at, and agent.list() cannot see it.
  */
  it("finds a Response Engine no Agent points at", () => {
    const existing = [provisioned("clinic")];

    expect(findOrphanedLlms(["llm_clinic_1", "llm_stranded"], existing)).toEqual(
      ["llm_stranded"],
    );
  });

  it("finds nothing when every LLM is referenced", () => {
    const existing = TEMPLATES.map((t) => provisioned(t.businessType));
    const llmIds = existing.map((agent) => agent.llmId!);

    expect(findOrphanedLlms(llmIds, existing)).toEqual([]);
  });

  it("does not treat an agent without an LLM as referencing one", () => {
    const existing: ExistingAgent[] = [
      { agentId: "agent_1", agentName: "callzie-clinic", llmId: null },
    ];

    expect(findOrphanedLlms(["llm_stranded"], existing)).toEqual([
      "llm_stranded",
    ]);
  });
});
