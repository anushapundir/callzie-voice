import { describe, expect, it } from "vitest";

import { admitCall, parseInboundCall, rejectCall } from "@/lib/inbound/payload";

/*
  The envelope, both ways. Shapes verified against
  docs.retellai.com/features/inbound-call-webhook.
*/

function callInbound(overrides: Record<string, unknown> = {}) {
  return {
    event: "call_inbound",
    event_timestamp: 1780012672105,
    call_inbound: {
      agent_id: "agent_12345",
      agent_version: 1,
      from_number: "+12137771234",
      to_number: "+12137771235",
      ...overrides,
    },
  };
}

describe("parseInboundCall", () => {
  it("reads the two numbers it needs", () => {
    expect(parseInboundCall(callInbound())).toEqual({
      toNumber: "+12137771235",
      fromNumber: "+12137771234",
    });
  });

  it("ignores everything else in the envelope", () => {
    // agent_id, agent_version and custom_sip_headers are all present and all
    // deliberately unread — Callzie chooses the Agent itself.
    const parsed = parseInboundCall(
      callInbound({ custom_sip_headers: { "x-my-header": "value" } }),
    );

    expect(Object.keys(parsed ?? {}).sort()).toEqual([
      "fromNumber",
      "toNumber",
    ]);
  });

  describe("a withheld caller ID", () => {
    /*
      Arrives as an empty string on some carriers and as an absent field on
      others. Both mean the same thing, so both become null and `decideInbound`
      has one case rather than three.
    */
    it("becomes null when absent", () => {
      const body = callInbound();
      delete (body.call_inbound as Record<string, unknown>).from_number;

      expect(parseInboundCall(body)?.fromNumber).toBeNull();
    });

    it("becomes null when empty", () => {
      expect(parseInboundCall(callInbound({ from_number: "" }))?.fromNumber)
        .toBeNull();
    });
  });

  describe("what it refuses to read", () => {
    it("refuses a text message on the same URL", () => {
      /*
        Retell's inbound webhook covers SMS as well, and it shares this URL.
        Answering a text with an agent id is not a harmless no-op — it is
        Callzie claiming to have handled something it has not.
      */
      const sms = { ...callInbound(), event: "sms_inbound" };

      expect(parseInboundCall(sms)).toBeNull();
    });

    it("refuses a body with no to_number", () => {
      // The tenant key. Without it there is nothing to look up.
      const body = callInbound();
      delete (body.call_inbound as Record<string, unknown>).to_number;

      expect(parseInboundCall(body)).toBeNull();
    });

    it("refuses an empty to_number", () => {
      expect(parseInboundCall(callInbound({ to_number: "" }))).toBeNull();
    });

    it.each([null, undefined, "a string", 42, [], [callInbound()]])(
      "refuses %p",
      (body) => {
        expect(parseInboundCall(body)).toBeNull();
      },
    );

    it("refuses an envelope with no call_inbound object", () => {
      expect(parseInboundCall({ event: "call_inbound" })).toBeNull();
    });
  });
});

describe("the reply", () => {
  it("declines with reject alone", () => {
    /*
      Nothing but the flag. Retell gives `reject` priority over agent selection,
      so an agent id sent alongside it would be dead weight that reads as though
      it might do something.
    */
    expect(rejectCall()).toEqual({ call_inbound: { reject: true } });
    expect(rejectCall().call_inbound).not.toHaveProperty("override_agent_id");
  });

  it("admits with the Agent, the variables and the metadata", () => {
    const reply = admitCall({
      agentId: "agent_inbound_clinic",
      dynamicVariables: { business_name: "Nair Dental" },
      metadata: { business_id: "11111111-2222-3333-4444-555555555555" },
    });

    expect(reply).toEqual({
      call_inbound: {
        override_agent_id: "agent_inbound_clinic",
        dynamic_variables: { business_name: "Nair Dental" },
        metadata: { business_id: "11111111-2222-3333-4444-555555555555" },
      },
    });
  });

  it("never carries reject on an admission", () => {
    // `reject` wins over everything, so a stray one here would silently decline
    // every call while the rest of the reply looked perfectly correct.
    const reply = admitCall({
      agentId: "agent_1",
      dynamicVariables: {},
      metadata: {},
    });

    expect(reply.call_inbound).not.toHaveProperty("reject");
  });
});
