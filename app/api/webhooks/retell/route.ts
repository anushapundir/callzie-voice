import { after } from "next/server";

import { parseWebhookPayload } from "@/lib/webhooks/payload";
import { processWebhookEvent } from "@/lib/webhooks/process";
import { describeSignature, verifySignature } from "@/lib/webhooks/signature";
import { markProcessed, recordEvent } from "@/lib/webhooks/store";

/*
  Where Retell tells Callzie how a Call went (SPEC.md §7, docs/verification.md
  A8). The URL is baked into every Agent by scripts/create-agent.ts:173.

  The order of this function is the design, and every line of it is one of
  SPEC.md §3's hard rules:

    1. Read the body RAW, never `.json()` first — the signature is over exact
       bytes, so parsing and re-serialising verifies a different string (rule 4,
       A8 point 2).
    2. Verify before looking at anything. This route is public in proxy.ts
       because a machine caller has no session cookie, so the signature is the
       only gate there is (rule 4).
    3. Persist the raw event, then return 200, then process (rules 2 and 3).

  It is deliberately thin. Everything it calls lives in lib/webhooks/ and is
  tested without a request.
*/

export async function POST(request: Request): Promise<Response> {
  // RAW. Never `await request.json()` — see rule 1 above.
  const rawBody = await request.text();
  const signature = request.headers.get("x-retell-signature");

  /*
    `verifySignature` returns a verdict rather than a boolean so that forgetting
    the `await` is a compile error instead of an open door. Written
    `if (!Retell.verify(...))`, an un-awaited Promise is always truthy, the
    negation always false, and every forged payload is accepted — the first of
    A8's four traps and the one this ticket names.
  */
  if ((await verifySignature(rawBody, signature)) !== "ok") {
    // Says which of the four it was — wrong key, stale clock, or a header a
    // proxy dropped. Never the digest itself.
    console.error(`[webhook] refused: ${describeSignature(signature)}`);
    return new Response("Unauthorized", { status: 401 });
  }

  const event = parseWebhookPayload(rawBody);
  if (!event) {
    /*
      A 400, even though Retell will retry it three times. A body our own key
      signed and we cannot read means the contract broke on one side or the
      other; a 200 here would hide that for good.
    */
    console.error("[webhook] signed body could not be read as an event");
    return new Response("Bad Request", { status: 400 });
  }

  /*
    Persisted before anything is processed, and the store decides whether there
    is work left in this delivery. A duplicate that has already been handled
    falls through to the 200 below having done nothing at all — SPEC.md §3
    rule 2.
  */
  const { id, decision } = await recordEvent(event, JSON.parse(rawBody));

  if (decision === "process") {
    /*
      `after()` runs this once the response is sent, so Retell gets its 200 well
      inside the 10-second timeout however slow the database is (rule 3).

      Safe on Cloud Run because the service is deployed with
      `--no-cpu-throttling` (scripts/setup-infrastructure.sh:484). Without it,
      CPU is withdrawn the moment the response goes out and this work would be
      starved half-done — the trap SPEC.md §13 item 7 left open. See ADR-0012.

      `markProcessed` runs after the work, never before, so a failure here leaves
      the row open for the next delivery to pick up.
    */
    after(async () => {
      await processWebhookEvent(event);
      await markProcessed(id);
    });
  }

  return new Response(null, { status: 200 });
}
