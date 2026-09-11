import { eq, like } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import { parseWebhookPayload } from "@/lib/webhooks/payload";
import { markProcessed, recordEvent } from "@/lib/webhooks/store";

/*
  Duplicate delivery, which SPEC.md §3 rule 2 makes a hard rule.

  Retell's webhook times out after 10 seconds and retries up to three times
  (docs/verification.md A7), so the same event arriving twice is routine. Two
  cases have to come apart, and getting them the same way round is the whole
  ticket:

    - Already processed  -> do nothing, still answer 200.
    - Stored but NOT processed -> do it again. This is the slow first attempt
      being redelivered while it is still working. Skipping it loses the event
      outright, because Retell will not send a third copy after a 200.

  `webhook_events` has no foreign keys, so these rows can be written and deleted
  on their own. Everything this file creates is prefixed, and the prefix is what
  makes the cleanup unable to over-reach.
*/

const PREFIX = "call_store_test_";

/** A parsed event for a call id of our own, so no two tests collide. */
function event(callId: string, type = "call_ended", extra = {}) {
  const parsed = parseWebhookPayload(
    JSON.stringify({
      event: type,
      call: { call_id: `${PREFIX}${callId}`, ...extra },
    }),
  );
  if (!parsed) throw new Error("test fixture did not parse");
  return parsed;
}

async function rows(callId: string) {
  return db
    .select()
    .from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.retellCallId, `${PREFIX}${callId}`));
}

async function clean() {
  await db
    .delete(schema.webhookEvents)
    .where(like(schema.webhookEvents.retellCallId, `${PREFIX}%`));
}

beforeEach(clean);
afterEach(clean);

describe("recordEvent", () => {
  it("stores a first delivery and asks for it to be processed", async () => {
    const { decision } = await recordEvent(event("first"), { any: "payload" });

    expect(decision).toBe("process");
    expect(await rows("first")).toHaveLength(1);
  });

  it("keeps the raw body verbatim", async () => {
    const raw = { event: "call_ended", call: { call_id: "whatever" } };

    await recordEvent(event("raw"), raw);

    expect((await rows("raw"))[0].payload).toEqual(raw);
  });

  /*
    The case the ticket calls out by name. The row exists because the first
    delivery got as far as storing it; it is unprocessed because that delivery
    was still working when Retell gave up waiting.
  */
  it("re-processes a row that was stored but never processed", async () => {
    await recordEvent(event("retry"), {});

    const { decision } = await recordEvent(event("retry"), {});

    expect(decision).toBe("process");
  });

  it("does nothing for a row that was already processed", async () => {
    const first = await recordEvent(event("done"), {});
    await markProcessed(first.id);

    const { decision } = await recordEvent(event("done"), {});

    expect(decision).toBe("already_done");
  });

  it("writes one row however many times an event is delivered", async () => {
    await recordEvent(event("many"), {});
    await recordEvent(event("many"), {});
    await recordEvent(event("many"), {});

    expect(await rows("many")).toHaveLength(1);
  });

  it("points every delivery at the same row", async () => {
    const first = await recordEvent(event("same"), {});
    const second = await recordEvent(event("same"), {});

    expect(second.id).toBe(first.id);
  });

  /*
    The dedupe key is the pair, not the Call. One Call produces three events and
    all three must land.
  */
  it("keeps the three events of one Call apart", async () => {
    for (const type of ["call_started", "call_ended", "call_analyzed"]) {
      const { decision } = await recordEvent(event("three", type), {});
      expect(decision).toBe("process");
    }

    expect(await rows("three")).toHaveLength(3);
  });

  /*
    A redelivered `call_ended` can carry more than the first one did — A9 records
    `recording_url` timing as unverified, so the retry may be the copy that has
    it. Keeping the newest body means the stored evidence is the fullest one.
  */
  it("keeps the newest body when an event is redelivered", async () => {
    await recordEvent(event("fuller"), { recording_url: null });

    await recordEvent(event("fuller"), { recording_url: "https://x/y.wav" });

    expect((await rows("fuller"))[0].payload).toEqual({
      recording_url: "https://x/y.wav",
    });
  });
});

describe("markProcessed", () => {
  it("closes the row so a later delivery is a no-op", async () => {
    const { id } = await recordEvent(event("close"), {});

    await markProcessed(id);

    expect((await rows("close"))[0].processed).toBe(true);
  });

  /*
    Called after the work, never before. A process that dies halfway leaves the
    row open, so the next delivery picks it up rather than finding it closed over
    work that never happened.
  */
  it("leaves a row open until it is called", async () => {
    await recordEvent(event("open"), {});

    expect((await rows("open"))[0].processed).toBe(false);
  });
});
