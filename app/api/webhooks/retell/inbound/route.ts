import { answerInboundCall } from "@/lib/inbound/answer";
import { admitCall, parseInboundCall, rejectCall } from "@/lib/inbound/payload";
import { describeSignature, verifySignature } from "@/lib/webhooks/signature";

/*
  Where Retell asks whether to put a caller through (issue #43).

  Distinct from ../route.ts next door, which is told how a Call went afterwards.
  This one is asked a question *while the phone is ringing* and its answer decides
  whether anybody is connected at all.

  Three things make this route unlike every other one in the app:

  1. **It has ten seconds, and it must never use them.** Retell waits ten seconds
     and retries three times. A slow answer here is a caller listening to silence
     with no idea anything is happening. `answerInboundCall` is a handful of
     indexed reads and nothing else — no LLM, no third-party call.

  2. **A failure must still be an answer.** Anything thrown below becomes a
     rejection rather than a 500. Retell's documented behaviour on a malformed
     response is one of this ticket's open verification items, and until it is
     settled the safe reading is that an unhandled error means an unanswered
     phone. A decline is a bad outcome; an exception is an unpredictable one.

  3. **It writes nothing.** There is no `retell_call_id` yet, so there is no
     `calls` row to write. `business_id` rides through in `metadata` and the
     ordinary `call_started` delivery — already idempotent, already verified —
     creates the row.

  ⚠️ **The signature scheme here is not yet confirmed.** Retell's inbound webhook
  page says to "verify the webhook using your Retell API key" without naming the
  header or the construction, and it is not stated to be the same
  `X-Retell-Signature` flow that `docs/verification.md` A8 records for call
  events. This route assumes it is, and fails closed if it is not.

  Fail-closed is the deliberate choice, and it has a cost worth stating: if the
  assumption is wrong, every inbound call is refused until somebody looks. That
  is the better failure. The alternative is an unauthenticated endpoint which,
  given a phone number, reveals which Business owns it and how it is configured —
  enumerable by anyone with a list of numbers.
*/

export async function POST(request: Request): Promise<Response> {
  // RAW, for the same reason as the call webhook: a signature is over exact
  // bytes, so parsing and re-serialising verifies a different string.
  const rawBody = await request.text();
  const signature = request.headers.get("x-retell-signature");

  if ((await verifySignature(rawBody, signature)) !== "ok") {
    console.error(`[inbound] refused: ${describeSignature(signature)}`);
    return new Response("Unauthorized", { status: 401 });
  }

  const parsed = parseInboundCall(rawBody ? safeJson(rawBody) : null);
  if (!parsed) {
    /*
      Includes `sms_inbound`, which shares this URL. Declining a text message is
      correct — Callzie has nothing to say to one — and a 200 with a rejection
      says so more accurately than a 400 would.
    */
    console.error("[inbound] signed body was not a call_inbound event");
    return Response.json(rejectCall());
  }

  try {
    const answer = await answerInboundCall({
      toNumber: parsed.toNumber,
      fromNumber: parsed.fromNumber,
    });

    if (!answer.admit) {
      /*
        Logged with the reason, because "your phone rang and we did not answer"
        is something an account is owed an explanation for. The number that was
        dialled is logged; the caller's is not — it is a stranger's phone number
        and nothing here needs it in a log file.
      */
      console.warn(`[inbound] declined ${parsed.toNumber}: ${answer.reason}`);
      return Response.json(rejectCall());
    }

    return Response.json(
      admitCall({
        agentId: answer.agentId,
        dynamicVariables: answer.dynamicVariables,
        /*
          The whole reason the Tools can work. Every inbound Tool resolves its
          tenant from this, never from an argument the model wrote — the same
          rule `lib/retell/tools.ts` states for the outbound four, and the thing
          that stops one hallucinated uuid becoming a cross-tenant write.
        */
        metadata: { business_id: answer.businessId },
      }),
    );
  } catch (error) {
    // Point 2 above. An exception must not become silence on the line.
    console.error(`[inbound] failed for ${parsed.toNumber}:`, error);
    return Response.json(rejectCall());
  }
}

/** JSON.parse that yields null instead of throwing, so the parser decides. */
function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
