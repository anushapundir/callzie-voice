import { and, eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import type { BusinessType, CallDirection } from "@/lib/db/schema";

/** A provisioned Retell Agent — the `retell_agents` row behind a Template. */
export type RetellAgentRecord = typeof schema.retellAgents.$inferSelect;

/*
  Keyed by (business_type, direction) since issue #43.

  There are two Agents per Business Type now — one that calls out about an
  Appointment, one that answers the phone — and they differ in prompt, in Tool
  set and in call cap. `direction` defaults to "outbound" in every signature
  here, so every caller written before inbound existed still means what it said.
*/

/**
 * Records the Agent provisioned for a Template.
 *
 * Called once per Template by `scripts/create-agent.ts`, which is re-runnable by
 * design — re-running is how the Agents get re-pointed after the deployed URL
 * changes. So this is an upsert on the primary key rather than an insert: the
 * second run must land on the same row, not collide with it.
 *
 * Note the direction of truth. These rows are an *output* of reconciling against
 * Retell, never an input to it — the script asks Retell what exists, then records
 * the answer here. A row that disagrees with Retell is stale, not authoritative.
 */
export async function upsertAgentRecord(
  businessType: BusinessType,
  llmId: string,
  agentId: string,
  direction: CallDirection = "outbound",
): Promise<RetellAgentRecord> {
  const [record] = await db
    .insert(schema.retellAgents)
    .values({ businessType, direction, llmId, agentId })
    .onConflictDoUpdate({
      /*
        Both columns, because both are the primary key. Targeting
        `businessType` alone no longer names a unique constraint, so Postgres
        rejects the statement outright — which is the good failure. The bad one
        would have been a target that still resolved and quietly let the inbound
        Agent overwrite the outbound one's row.
      */
      target: [schema.retellAgents.businessType, schema.retellAgents.direction],
      set: { llmId, agentId, updatedAt: new Date() },
    })
    .returning();

  return record;
}

/** Every provisioned Agent, for the script's drift check. */
export async function listAgentRecords(): Promise<RetellAgentRecord[]> {
  return db.select().from(schema.retellAgents);
}

/**
 * The Agent that conducts Calls for a Business of this type, in this direction.
 *
 * Throws rather than returning null: there is no sensible fallback Agent, and a
 * Call placed against the wrong one would reach a customer speaking the wrong
 * persona. The message names the fix because the failure is a provisioning gap,
 * not a bug — most often a database that the script has never been run against.
 *
 * For an inbound Call the stakes are a little different and a little worse: the
 * inbound webhook has ten seconds to answer and this throwing inside it means
 * the caller hears nothing at all. That path catches and rejects the Call rather
 * than letting the exception escape — see lib/inbound/decide.ts.
 */
export async function agentIdFor(
  businessType: BusinessType,
  direction: CallDirection = "outbound",
): Promise<string> {
  const [record] = await db
    .select()
    .from(schema.retellAgents)
    .where(
      and(
        eq(schema.retellAgents.businessType, businessType),
        eq(schema.retellAgents.direction, direction),
      ),
    )
    .limit(1);

  if (!record) {
    throw new Error(
      `No ${direction} Retell Agent provisioned for business type ` +
        `'${businessType}'. Run \`npm run create-agents\` against this database.`,
    );
  }

  return record.agentId;
}
