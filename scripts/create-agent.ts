import { config } from "dotenv";
import type { LlmCreateParams } from "retell-sdk/resources/llm";
import type Retell from "retell-sdk";

// Next loads .env.local itself; a plain Node process does not. Same mechanism and
// same reason as vitest.setup.ts.
config({ path: ".env.local" });

import type { BusinessType } from "@/lib/db/schema";
import { BUSINESS_TYPES } from "@/lib/db/schema";
import { retellClient } from "@/lib/retell/client";
import { flagSet, flagValue } from "@/lib/retell/flags";
import {
  type Action,
  type ExistingAgent,
  findOrphanedLlms,
  hasConflicts,
  planAgents,
} from "@/lib/retell/reconcile";
import {
  ALL_TEMPLATES,
  type Template,
  estimateTokens,
  maxCallDurationFor,
  promptFor,
  toolNamesFor,
} from "@/lib/retell/templates";
import { END_CALL_TOOL, customTools } from "@/lib/retell/tools";

/*
  Provisions the four Retell Agents, one per Template (SPEC.md §7), using the
  two-step Response Engine flow from docs/verification.md A4: create the Retell
  LLM that carries the prompt and Tools, then the Agent that points at it.

  This file performs; it decides nothing. The Templates, the Tool schemas and the
  create-versus-update plan all live in lib/retell/, where they are unit-testable
  without a network. What is here is flags, preflight, ordering, the API calls and
  the output.

  Re-running is the normal case, not the exception: the Tool URLs and webhook URL
  bake APP_URL in at creation time, so re-running is how the Agents get
  re-pointed once the Cloud Run URL exists. It updates in place and never
  duplicates.

  Usage:
    npm run create-agents                    provision or update all four
    npm run create-agents -- --check         plan only; exit 1 if anything drifts
                                            (--dry-run also works, but npm eats
                                             that flag — see parseFlags)
    npm run create-agents -- --offline       render prompts and schemas, no network
    npm run create-agents -- --only clinic   one Template
    npm run create-agents -- --list-voices   pick a voice id
*/

// SPEC.md §7. Every one of these is a cost guardrail, and every one belongs in
// config rather than in the prompt — a prompt instruction is a suggestion
// (SPEC.md §3 rule 6).
const MODEL = "gpt-5-nano" as const; // cheapest tier, $0.003/min
// The duration cap moved to lib/retell/templates.ts in issue #43, because it is
// now per direction — 180s outbound, 300s inbound. See `maxCallDurationFor`.
const END_CALL_AFTER_SILENCE_MS = 15_000;

/*
  There is no begin_message_delay_ms here any more, on purpose.

  The first real Phone Call (docs/verification.md A2, 2026-08-22) showed Retell
  starts the Agent talking the instant the *carrier* signals answer, which is
  not the instant a person says hello — a screening service picked up first and
  clipped Maya's opening to "Hi, this is ". A 1500ms delay was the first fix,
  but a fixed delay only moves the gap: the carrier can be seconds early.

  The real fix is per-call: Phone Calls now override `start_speaker` to "user"
  so Maya waits for an actual hello (PHONE_AGENT_OVERRIDE in
  lib/calls/start-call.ts). That makes a delay here useless on the phone route
  — Maya no longer speaks first there — and on Web Calls it was only ever a
  pointless 1.5-second pause after clicking "Start call".
*/
const WEBHOOK_EVENTS = ["call_started", "call_ended", "call_analyzed"] as const;
const WEBHOOK_PATH = "/api/webhooks/retell";
const LANGUAGE = "en-US" as const;

type Flags = {
  dryRun: boolean;
  offline: boolean;
  listVoices: boolean;
  allowLocalhost: boolean;
  only: BusinessType | null;
};

// Both read npm_config_* as well as argv — npm eats flags passed after `--`.
// See lib/retell/flags.ts; this is not a detail worth rediscovering.
function parseFlags(argv: string[]): Flags {
  const only = flagValue(argv, "--only");

  if (only !== null && !BUSINESS_TYPES.includes(only as BusinessType)) {
    fail(
      `--only expects one of ${BUSINESS_TYPES.join(", ")}; got ${only ?? "nothing"}.`,
    );
  }

  return {
    dryRun: flagSet(argv, "--dry-run") || flagSet(argv, "--check"),
    offline: flagSet(argv, "--offline"),
    listVoices: flagSet(argv, "--list-voices"),
    allowLocalhost: flagSet(argv, "--allow-localhost"),
    only: (only as BusinessType | null) ?? null,
  };
}

/**
 * Loads the `retell_agents` accessors, and with them the database pool.
 *
 * Deliberately a dynamic import: lib/db/index.ts opens a pool and throws at
 * module scope when DATABASE_URL is unset, which would break --offline and
 * --list-voices — the two modes whose whole point is to run on a machine with no
 * credentials and no Cloud SQL Auth Proxy.
 */
async function agentStore() {
  return import("@/lib/retell/agents");
}

function fail(message: string): never {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

function requireEnv(name: string, remedy: string): string {
  const value = process.env[name];

  if (!value) fail(`${name} is not set. ${remedy}`);

  return value;
}

/**
 * Refuses to bake a localhost URL into four Agents.
 *
 * Retell calls the Tool URLs from its own servers, so agents built against
 * http://localhost:3000 have four Tools that nothing can reach — and the failure
 * surfaces mid-demo as Maya stalling, not as an error here.
 */
function checkAppUrl(appUrl: string, allowLocalhost: boolean): void {
  const { hostname } = new URL(appUrl);

  if (hostname !== "localhost" && hostname !== "127.0.0.1") return;

  if (allowLocalhost) {
    console.warn(
      `  ! APP_URL is ${appUrl}. Retell cannot reach these Tools — the Agents\n` +
        "    will connect but every Tool call will fail. Re-run after deploying.\n",
    );
    return;
  }

  fail(
    `APP_URL is ${appUrl}. Retell calls your Tool URLs from its own servers, so\n` +
      "    these Agents would have four unreachable Tools and Maya would stall\n" +
      "    mid-call. Deploy first (scripts/setup-infrastructure.sh writes the real\n" +
      "    APP_URL), or pass --allow-localhost to shake out the prompts now and\n" +
      "    re-run afterwards — this script updates in place.",
  );
}

/** The Response Engine payload: the prompt, the Tools, and the model tier. */
function llmPayload(
  template: Template,
  appUrl: string,
  internalSecret: string,
): LlmCreateParams {
  return {
    model: MODEL,
    start_speaker: "agent",
    // Never unset: a dynamically generated opening triggers the 10-second
    // billing minimum (docs/verification.md A4).
    begin_message: template.beginMessage,
    general_prompt: promptFor(template),
    /*
      This Template's Tools plus Retell's built-in hang-up. Without end_call the
      Agent cannot end a call and every one bills to the cap.

      The set is chosen by direction, and that is a security boundary rather
      than tidiness (issue #43): an inbound Agent holding `book_slot` would
      invoke a Tool that looks for an Appointment the Call does not have, and an
      outbound Agent holding `book_appointment` could create rows during a
      confirmation call.
    */
    general_tools: [
      ...customTools(appUrl, internalSecret, toolNamesFor(template)),
      END_CALL_TOOL,
    ],
    // Inert label — never referenced in the prompt — so an LLM orphaned by a
    // crash between the two creation steps stays identifiable afterwards.
    default_dynamic_variables: { callzie_template: template.businessType },
  };
}

/** The Agent payload: voice, webhook, and the hard duration cap. */
function agentPayload(template: Template, appUrl: string) {
  return {
    agent_name: template.agentName,
    voice_id: template.voiceId,
    language: LANGUAGE,
    webhook_url: new URL(WEBHOOK_PATH, appUrl).toString(),
    webhook_events: [...WEBHOOK_EVENTS],
    /*
      The primary cost guardrail. A prompt cannot enforce this; that is the point.

      Per direction since issue #43: 180s outbound, 300s inbound. An enquiry
      followed by a booking is genuinely a longer conversation than a
      confirmation — the caller has to say what they want, hear what is free,
      choose, and give a name and a number.
    */
    max_call_duration_ms: maxCallDurationFor(template),
    end_call_after_silence_ms: END_CALL_AFTER_SILENCE_MS,
    // Explicit zero, so a re-run scrubs the 1500ms delay an earlier version
    // wrote onto the live Agents. See the note above WEBHOOK_EVENTS.
    begin_message_delay_ms: 0,
    /*
      Hang up on an answering machine rather than talking to it.

      Without this a Phone Call reaching voicemail runs the full 180-second cap
      reciting an appointment to a recording, at roughly $0.25 a minute. Retell
      watches the first three minutes of the call, which is longer than any Call
      Callzie places, so in practice it watches all of it.

      `hangup` rather than leaving a message, deliberately. SPEC.md §14 rule 2 —
      an unanswered phone is not a signal about the Appointment, and a voicemail
      Callzie left is not one either. The Slot stays held and the Call comes back
      as no_answer for a human to look at.
    */
    voicemail_option: { action: { type: "hangup" as const } },
  };
}

/**
 * Every agent in the workspace, with the Response Engine each points at.
 *
 * Two calls deep because `list-agents` returns only ids and names — the response
 * engine comes from retrieving each one. Only agents whose names Callzie owns are
 * retrieved, so a shared workspace costs at most four extra calls.
 */
async function loadExisting(
  client: Retell,
  templates: readonly Template[],
): Promise<ExistingAgent[]> {
  const wanted = new Set(templates.map((t) => t.agentName));
  const matched: { agentId: string; agentName: string }[] = [];

  let paginationKey: string | undefined;

  do {
    const page = await client.agent.list({
      limit: 1000,
      ...(paginationKey ? { pagination_key: paginationKey } : {}),
    });

    for (const item of page.items ?? []) {
      if (wanted.has(item.agent_name)) {
        matched.push({ agentId: item.agent_id, agentName: item.agent_name });
      }
    }

    paginationKey = page.has_more ? page.pagination_key : undefined;
  } while (paginationKey);

  return Promise.all(
    matched.map(async ({ agentId, agentName }) => {
      const agent = await client.agent.retrieve(agentId);
      const engine = agent.response_engine;

      return {
        agentId,
        agentName,
        llmId:
          engine.type === "retell-llm" && engine.llm_id ? engine.llm_id : null,
      };
    }),
  );
}

type Outcome = {
  template: Template;
  verb: "created" | "updated" | "relinked";
  agentId: string;
  llmId: string;
};

async function execute(
  client: Retell,
  action: Action,
  appUrl: string,
  internalSecret: string,
): Promise<Outcome> {
  const { template } = action;
  const llm = llmPayload(template, appUrl, internalSecret);
  const agent = agentPayload(template, appUrl);

  /*
    The LLM always moves first. The Agent's response_engine must point at an
    engine that already carries the current prompt and Tools, so that at no
    instant is a live Agent wired to a stale one.
  */
  if (action.kind === "create") {
    const created = await client.llm.create(llm);
    const createdAgent = await client.agent.create({
      ...agent,
      response_engine: { type: "retell-llm", llm_id: created.llm_id },
    });

    return {
      template,
      verb: "created",
      agentId: createdAgent.agent_id,
      llmId: created.llm_id,
    };
  }

  if (action.kind === "relink") {
    const created = await client.llm.create(llm);
    await client.agent.update(action.agentId, {
      ...agent,
      response_engine: { type: "retell-llm", llm_id: created.llm_id },
    });

    return {
      template,
      verb: "relinked",
      agentId: action.agentId,
      llmId: created.llm_id,
    };
  }

  if (action.kind === "update") {
    try {
      await client.llm.update(action.llmId, llm);
    } catch (error) {
      /*
        The Agent survived but its Response Engine was deleted from the
        dashboard. Recover by building a fresh one and re-pointing the Agent,
        rather than aborting the whole run over one Template.
      */
      if (!isNotFound(error)) throw error;

      console.warn(
        `  ! ${action.template.businessType}: ${action.llmId} is gone; creating a replacement.`,
      );

      return execute(
        client,
        { kind: "relink", template, agentId: action.agentId, reason: "llm 404" },
        appUrl,
        internalSecret,
      );
    }

    await client.agent.update(action.agentId, agent);

    return {
      template,
      verb: "updated",
      agentId: action.agentId,
      llmId: action.llmId,
    };
  }

  throw new Error(`Refusing to execute a ${action.kind} action.`);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: number }).status === 404
  );
}

/** Renders everything that will be sent, without contacting Retell. */
function renderOffline(templates: readonly Template[], appUrl: string): void {
  // A placeholder, never the real secret — this output is meant to be pasted
  // into a review.
  for (const template of templates) {
    // Per Template since issue #43: the two directions carry different Tool
    // sets, so a single shared list would under-count the inbound token budget.
    const tools = customTools(
      appUrl,
      "<INTERNAL_SECRET>",
      toolNamesFor(template),
    );
    const prompt = promptFor(template);
    const tokens = estimateTokens(
      prompt + template.beginMessage + JSON.stringify(tools),
    );

    console.log(`\n${"─".repeat(72)}`);
    console.log(`  ${template.agentName}   (~${tokens} tokens, budget 4000)`);
    console.log(`${"─".repeat(72)}\n`);
    console.log(`  begin_message: ${template.beginMessage}\n`);
    console.log(prompt);
  }

  /*
    Both Tool sets, labelled. One combined dump would hide the thing most worth
    reviewing here: that the inbound Agent is not armed with `book_slot` and the
    outbound one is not armed with `book_appointment` (issue #43).
  */
  for (const direction of ["outbound", "inbound"] as const) {
    const template = templates.find((t) => t.direction === direction);
    if (!template) continue;

    console.log(`\n${"─".repeat(72)}`);
    console.log(`  Tools — ${direction}\n`);
    console.log(
      JSON.stringify(
        [
          ...customTools(appUrl, "<INTERNAL_SECRET>", toolNamesFor(template)),
          END_CALL_TOOL,
        ],
        null,
        2,
      ),
    );
  }
}

function describe(action: Action): string {
  switch (action.kind) {
    case "create":
      return "create";
    case "update":
      return "update";
    case "relink":
      return `relink (${action.reason})`;
    case "conflict":
      return `CONFLICT: ${action.agentIds.join(", ")}`;
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));

  /*
    Eight Agents since issue #43 — four Business Types, each with an outbound
    Agent and an inbound one. `--only` still filters by Business Type and so
    now selects both of that type's Agents, which is what somebody iterating on
    one vertical wants.
  */
  const templates = flags.only
    ? ALL_TEMPLATES.filter((t) => t.businessType === flags.only)
    : ALL_TEMPLATES;

  const appUrl =
    process.env.APP_URL ??
    (flags.offline ? "https://example.invalid" : undefined);

  if (!appUrl) {
    fail(
      "APP_URL is not set. It is the origin Retell calls back on, so the Tool " +
        "and webhook URLs are built from it.",
    );
  }

  if (flags.offline) {
    renderOffline(templates, appUrl);
    return;
  }

  const client = retellClient();

  if (flags.listVoices) {
    const voices = await client.voice.list();

    for (const voice of voices) {
      console.log(
        `  ${voice.voice_id}\t${voice.voice_name}\t${voice.gender}\t${voice.accent ?? ""}`,
      );
    }
    return;
  }

  const internalSecret = requireEnv(
    "INTERNAL_SECRET",
    "It authenticates the Agent's Tool calls; scripts/setup-infrastructure.sh generates it.",
  );
  requireEnv(
    "DATABASE_URL",
    "The provisioned ids are recorded in Postgres; start the Cloud SQL Auth Proxy first.",
  );

  checkAppUrl(appUrl, flags.allowLocalhost);

  const existing = await loadExisting(client, templates);
  const plan = planAgents(templates, existing);

  console.log("");
  for (const action of plan) {
    console.log(
      `  ${action.template.businessType.padEnd(14)} ${describe(action)}`,
    );
  }
  console.log("");

  if (hasConflicts(plan)) {
    fail(
      "Two or more Agents share a Callzie name. Refusing to guess which is live —\n" +
        "    delete the extras in the Retell dashboard, then re-run.",
    );
  }

  if (flags.dryRun) {
    const { listAgentRecords } = await agentStore();
    const recorded = await listAgentRecords();
    const drift = plan.filter((action) => action.kind !== "update");
    const unrecorded = plan.filter(
      (action) =>
        action.kind === "update" &&
        !recorded.some(
          (row) =>
            row.businessType === action.template.businessType &&
            // Both halves of the key. Without `direction` an inbound Agent
            // recorded against the outbound row would read as "in sync".
            row.direction === action.template.direction &&
            row.agentId === action.agentId,
        ),
    );

    if (drift.length === 0 && unrecorded.length === 0) {
      console.log(`  ${plan.length} in sync.\n`);
      return;
    }

    for (const action of unrecorded) {
      console.warn(
        `  ! ${action.template.businessType}: Retell and retell_agents disagree.`,
      );
    }

    // Non-zero so --dry-run doubles as a check in a pipeline.
    fail(`${drift.length + unrecorded.length} of ${plan.length} would change.`);
  }

  // Sequential, deliberately. Four Templates is few, the calls are cheap, and
  // serial output is far easier to read than interleaved failures.
  const { upsertAgentRecord } = await agentStore();
  const outcomes: Outcome[] = [];

  for (const action of plan) {
    const outcome = await execute(client, action, appUrl, internalSecret);
    await upsertAgentRecord(
      outcome.template.businessType,
      outcome.llmId,
      outcome.agentId,
      /*
        Not optional in practice, whatever the default says. `retell_agents` is
        keyed by (business_type, direction) since issue #43 — omit this and all
        eight Agents upsert into four rows, with each inbound id overwriting the
        outbound one it shares a Business Type with. Nothing would error; the
        outbound Web Call path would simply start reaching the inbound Agent,
        and a customer would be asked "how can I help?" about an appointment
        Callzie rang them to confirm.
      */
      outcome.template.direction,
    );
    outcomes.push(outcome);
  }

  for (const outcome of outcomes) {
    console.log(
      `  ${outcome.template.businessType.padEnd(14)} ${outcome.verb.padEnd(9)} ${outcome.agentId}  ${outcome.llmId}`,
    );
  }

  /*
    Only on a full run. Under --only the other three Templates' Response Engines
    are perfectly healthy but absent from `outcomes`, and reporting them as
    orphans would train the reader to ignore the warning.

    Built from what this run just produced, so an engine replaced by a relink is
    correctly reported as orphaned rather than looking still-referenced.
  */
  if (!flags.only) {
    await reportOrphans(
      client,
      outcomes.map((outcome) => ({
        agentId: outcome.agentId,
        agentName: outcome.template.agentName,
        llmId: outcome.llmId,
      })),
    );
  }

  console.log(`\n  ${outcomes.length} Agents provisioned, recorded in retell_agents.\n`);
}

/**
 * Warns about Response Engines nothing points at.
 *
 * Reported, never deleted: an unreferenced LLM bills nothing, and silently
 * deleting something we did not certainly create is the wrong default.
 */
async function reportOrphans(
  client: Retell,
  live: readonly ExistingAgent[],
): Promise<void> {
  const callzieLlmIds: string[] = [];
  let paginationKey: string | undefined;

  do {
    const page = await client.llm.list({
      limit: 1000,
      ...(paginationKey ? { pagination_key: paginationKey } : {}),
    });

    for (const llm of page.items ?? []) {
      if (llm.default_dynamic_variables?.callzie_template) {
        callzieLlmIds.push(llm.llm_id);
      }
    }

    paginationKey = page.has_more ? page.pagination_key : undefined;
  } while (paginationKey);

  const orphans = findOrphanedLlms(callzieLlmIds, live);

  for (const llmId of orphans) {
    console.warn(
      `  ! orphan Response Engine ${llmId} — no Agent points at it. Delete it in ` +
        "the Retell dashboard.",
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
