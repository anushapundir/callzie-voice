import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import type { BusinessType } from "@/lib/db/schema";
import { agentIdFor, listAgentRecords, upsertAgentRecord } from "@/lib/retell/agents";

/*
  Integration against the project's real Postgres, per vitest.config.mts — the
  invariant under test (one row per Business Type) is a primary key, so a mocked
  db would only test the mock.

  ⚠️ `retell_agents` is a four-row lookup table shared by every account, not
  per-account data, so a test that wrote 'clinic' would overwrite the Agent the
  whole platform calls with — and its cleanup would delete it. Hence a sentinel
  key that is deliberately not a BusinessType: the column is `text`, so Postgres
  accepts it, and nothing real can collide with it.
*/
const TEST_KEY = "__test_business_type__" as BusinessType;

async function cleanup() {
  await db
    .delete(schema.retellAgents)
    .where(eq(schema.retellAgents.businessType, TEST_KEY));
}

async function rowsFor(businessType: BusinessType) {
  return db
    .select()
    .from(schema.retellAgents)
    .where(eq(schema.retellAgents.businessType, businessType));
}

describe("upsertAgentRecord", () => {
  afterEach(cleanup);

  it("records a newly provisioned Agent", async () => {
    const record = await upsertAgentRecord(TEST_KEY, "llm_a", "agent_a");

    expect(record.llmId).toBe("llm_a");
    expect(record.agentId).toBe("agent_a");
    expect(await rowsFor(TEST_KEY)).toHaveLength(1);
  });

  /*
    The script is re-runnable by design — re-running is how the Agents get
    re-pointed after the deployed URL changes — so the second run has to land on
    the same row rather than collide with it.
  */
  it("overwrites in place on a re-run", async () => {
    await upsertAgentRecord(TEST_KEY, "llm_a", "agent_a");
    const second = await upsertAgentRecord(TEST_KEY, "llm_b", "agent_b");

    expect(second.llmId).toBe("llm_b");
    expect(second.agentId).toBe("agent_b");
    expect(await rowsFor(TEST_KEY)).toHaveLength(1);
  });

  it("lists what has been provisioned", async () => {
    await upsertAgentRecord(TEST_KEY, "llm_a", "agent_a");

    const records = await listAgentRecords();

    expect(records.map((r) => r.businessType)).toContain(TEST_KEY);
  });
});

describe("agentIdFor", () => {
  afterEach(cleanup);

  it("resolves a provisioned Business Type", async () => {
    await upsertAgentRecord(TEST_KEY, "llm_a", "agent_a");

    expect(await agentIdFor(TEST_KEY)).toBe("agent_a");
  });

  /*
    No fallback Agent exists, and a Call placed against the wrong one would reach
    a customer speaking the wrong persona. The message has to name the fix,
    because the usual cause is a database the script never ran against.
  */
  it("refuses to guess when nothing is provisioned", async () => {
    await expect(agentIdFor(TEST_KEY)).rejects.toThrow(
      /npm run create-agents/,
    );
  });
});
