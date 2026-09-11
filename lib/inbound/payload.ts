/*
  Retell's `call_inbound` envelope, and the reply it expects (issue #43).

  Verified against docs.retellai.com/features/inbound-call-webhook. The request:

    { "event": "call_inbound",
      "call_inbound": { "agent_id": "...", "agent_version": 1,
                        "from_number": "+1...", "to_number": "+1...",
                        "custom_sip_headers": { ... } } }

  And the reply, which must be 2xx with a `call_inbound` object. `reject` wins
  over everything else in it, which is why `rejectCall()` below returns nothing
  but that flag — sending an agent id alongside a rejection would be dead weight
  that reads as though it might do something.

  Dependency-free on purpose, matching `lib/retell/tools.ts`: a route handler and
  a plain Node script (the replay script) both import it.
*/

/** What Callzie reads off the request. Every other field is ignored. */
export type InboundCallRequest = {
  /** The number that was dialled — the tenant key. */
  toNumber: string;
  /** The caller, or null when the network withheld it. */
  fromNumber: string | null;
};

/**
 * Reads Retell's envelope, or returns null.
 *
 * Null rather than a thrown error, matching `parseToolRequest`: a malformed body
 * is an ordinary thing to receive on a URL reachable from the internet, and the
 * caller turns it into a 400.
 */
export function parseInboundCall(body: unknown): InboundCallRequest | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }

  const { event, call_inbound: inbound } = body as {
    event?: unknown;
    call_inbound?: unknown;
  };

  /*
    The event name is checked rather than assumed. The same URL will one day
    receive `sms_inbound` — Retell's inbound webhook covers both — and answering
    a text message with an agent id is not a harmless no-op, it is Callzie
    claiming to have handled something it has not.
  */
  if (event !== "call_inbound") return null;
  if (typeof inbound !== "object" || inbound === null) return null;

  const { to_number: to, from_number: from } = inbound as {
    to_number?: unknown;
    from_number?: unknown;
  };

  if (typeof to !== "string" || to === "") return null;

  /*
    A withheld caller ID arrives as an empty string on some carriers and as an
    absent field on others. Both mean the same thing and both become null, so
    `decideInbound` has one case to handle rather than three.
  */
  const fromNumber = typeof from === "string" && from !== "" ? from : null;

  return { toNumber: to, fromNumber };
}

/** The reply that declines a call. */
export function rejectCall(): { call_inbound: { reject: true } } {
  return { call_inbound: { reject: true } };
}

/** The reply that admits one, naming the Agent and the context it needs. */
export function admitCall({
  agentId,
  dynamicVariables,
  metadata,
}: {
  agentId: string;
  /*
    All values must be strings. Retell renders an unset or non-string variable
    literally, which means a plumbing bug is something Maya says out loud —
    "curly-curly-business-name" — rather than an error anybody sees
    (docs/verification.md A5).
  */
  dynamicVariables: Record<string, string>;
  metadata: Record<string, string>;
}) {
  return {
    call_inbound: {
      override_agent_id: agentId,
      dynamic_variables: dynamicVariables,
      metadata,
    },
  };
}
