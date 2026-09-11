import type { Template } from "@/lib/retell/templates";

/*
  Deciding what to do to Retell, without talking to it.

  Retell has no upsert, so "re-running does not create duplicates" has to be
  built. The mechanism is a stable agent name (lib/retell/templates.ts
  `agentNameFor`): the script asks Retell what agents exist, matches them by that
  name, and this module turns the answer into a plan.

  Kept pure — no network, no SDK import, no clock — because the interesting cases
  are the damaged ones (a half-finished run, a hand-edited dashboard, duplicates
  that already exist) and those are only cheap to test if the decision is a
  function. The script performs the plan; it does not decide it.
*/

/**
 * An agent that already exists in the Retell workspace.
 *
 * `llmId` is null when the agent is not backed by a Retell LLM at all — its
 * response engine is a custom LLM or a conversation flow. Note this cannot be
 * built from `agent.list()` alone, which returns only ids and names; the script
 * retrieves each matched agent to learn its response engine.
 */
export type ExistingAgent = {
  agentId: string;
  agentName: string;
  llmId: string | null;
};

export type Action =
  /** Nothing exists yet: create the Response Engine, then the Agent. */
  | { kind: "create"; template: Template }
  /** The normal re-run: push the current prompt, tools and config in place. */
  | { kind: "update"; template: Template; agentId: string; llmId: string }
  /** The Agent exists but is not backed by a Retell LLM we can update. */
  | { kind: "relink"; template: Template; agentId: string; reason: string }
  /** Two or more agents claim this name. Refuse to guess. */
  | { kind: "conflict"; template: Template; agentIds: string[] };

/**
 * What to do to each Template, given what Retell currently holds.
 *
 * Agents whose names Callzie does not own are ignored entirely — the workspace
 * may be shared, and this must never touch somebody else's agent.
 */
export function planAgents(
  templates: readonly Template[],
  existing: readonly ExistingAgent[],
): Action[] {
  return templates.map((template) => {
    const matches = existing.filter(
      (agent) => agent.agentName === template.agentName,
    );

    /*
      The case that actually satisfies "re-running does not *silently* create
      duplicates". The happy path is easy; what matters is the run that happens
      after duplicates already exist — because Retell does not enforce unique
      agent names, so a dashboard copy or an interrupted earlier run can leave
      two. Picking one at random would update an agent nobody is calling, and
      creating a third compounds it. Stop and let a human look.
    */
    if (matches.length > 1) {
      return {
        kind: "conflict",
        template,
        agentIds: matches.map((agent) => agent.agentId),
      };
    }

    const [match] = matches;

    if (!match) {
      return { kind: "create", template };
    }

    /*
      An Agent pointing at something other than a Retell LLM — someone switched it
      to a conversation flow in the dashboard, or an earlier run half-finished.
      There is no LLM of ours to update, so a fresh one is created and the Agent
      is re-pointed at it. The Agent id survives, which matters: it is what the
      retell_agents rows and any queued Call already reference.
    */
    if (!match.llmId) {
      return {
        kind: "relink",
        template,
        agentId: match.agentId,
        reason: "agent is not backed by a Retell LLM",
      };
    }

    return {
      kind: "update",
      template,
      agentId: match.agentId,
      llmId: match.llmId,
    };
  });
}

/** True when the plan is safe to execute — no template is ambiguous. */
export function hasConflicts(plan: readonly Action[]): boolean {
  return plan.some((action) => action.kind === "conflict");
}

/**
 * Callzie LLMs that no Callzie Agent points at.
 *
 * A crash between creating the Response Engine and creating the Agent leaves an
 * LLM that `agent.list()` cannot see. Every LLM the script creates is labelled
 * with `default_dynamic_variables.callzie_template` — inert, never referenced in
 * a prompt — so an orphan stays identifiable afterwards.
 *
 * Reported, never deleted automatically: an unreferenced LLM bills nothing, and
 * silently deleting something we did not certainly create is the wrong default.
 */
export function findOrphanedLlms(
  callzieLlmIds: readonly string[],
  existing: readonly ExistingAgent[],
): string[] {
  const referenced = new Set(
    existing.map((agent) => agent.llmId).filter((id): id is string => id !== null),
  );

  return callzieLlmIds.filter((llmId) => !referenced.has(llmId));
}
