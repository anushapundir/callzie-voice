import { eq, sql } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { buildInboundVariables } from "@/lib/inbound/variables";
import { authoriseWidget, type WidgetRejectReason } from "@/lib/widget/authorise";
import { agentIdFor } from "@/lib/retell/agents";

/*
  Opening a widget Call (issue #45).

  The orchestration between `authoriseWidget` — which decides — and Retell, which
  is contacted only once the answer is yes. Written the same way as
  `lib/calls/start-call.ts`: everything that can refuse does so before anything
  is spent, and the Retell call itself is injected so tests contact nobody
  (SPEC.md §3 rule 11).

  Unlike the phone path there is no `call_inbound` webhook here — Callzie creates
  the Retell call itself, so it sets the dynamic variables and the metadata
  directly. The Tools then resolve their tenant from that metadata exactly as
  they do for a phone call, and neither the Agent nor the Tools can tell the two
  apart. That is the design: one inbound Agent, two ways in.
*/

/** Creating a Web Call, as a function. Injected so tests contact nobody. */
export type WidgetCallCreator = (params: {
  agent_id: string;
  retell_llm_dynamic_variables: Record<string, string>;
  metadata: Record<string, string>;
}) => Promise<{ call_id: string; access_token: string }>;

export type WidgetStartResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: WidgetRejectReason | "call_failed" };

export async function startWidgetCall({
  key,
  origin,
  createCall,
  now = new Date(),
}: {
  key: string;
  origin: string | null;
  createCall: WidgetCallCreator;
  now?: Date;
}): Promise<WidgetStartResult> {
  const authorised = await authoriseWidget({ key, origin, now });
  if (!authorised.ok) return { ok: false, reason: authorised.reason };

  /*
    The same Agent and the same variables a phone caller gets. A visitor on the
    website and a caller on the phone are talking to the same business and must
    hear the same answers, which is why `buildInboundVariables` is shared rather
    than reimplemented here.
  */
  const agentId = await agentIdFor(authorised.businessType, "inbound");
  const variables = await buildInboundVariables(authorised.businessId, now);

  const [call] = await db
    .insert(schema.calls)
    .values({
      businessId: authorised.businessId,
      direction: "inbound",
      // Web, not phone — this is the pair the daily cap counts on.
      callType: "web",
      /*
        Null. A widget visitor has no phone number and inventing a placeholder
        would put a fake into a column every Tool reads as real —
        `lookup_appointment` would match on it, and one visitor would be shown
        another's Appointment.
      */
      fromNumber: null,
      status: "queued",
    })
    .returning({ id: schema.calls.id });

  let created: { call_id: string; access_token: string };
  try {
    created = await createCall({
      agent_id: agentId,
      retell_llm_dynamic_variables: variables,
      metadata: { business_id: authorised.businessId, callzie_call_id: call.id },
    });
  } catch {
    /*
      The compensating write. Retell never accepted the Call, so the row would
      otherwise sit `queued` forever — counting against the daily cap and
      showing on the dashboard as a Call that never happened.
    */
    await db
      .update(schema.calls)
      .set({ status: "failed", disconnectReason: "widget_create_failed" })
      .where(eq(schema.calls.id, call.id));

    return { ok: false, reason: "call_failed" };
  }

  await db
    .update(schema.calls)
    .set({ retellCallId: created.call_id })
    .where(eq(schema.calls.id, call.id));

  /*
    The allowance is spent here, after Retell agreed. Claiming it earlier would
    charge an account for a Call that failed to start; claiming it later would
    leave a window where a burst of requests all pass the check.
  */
  await db
    .update(schema.businesses)
    .set({ inboundCallsUsed: sql`${schema.businesses.inboundCallsUsed} + 1` })
    .where(eq(schema.businesses.id, authorised.businessId));

  return { ok: true, accessToken: created.access_token };
}
