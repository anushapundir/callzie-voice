import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as webhookRoute } from "@/app/api/webhooks/retell/route";
import { db, schema } from "@/lib/db";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";
import { webhookFixture, type WebhookFixture } from "@/lib/webhooks/fixtures";
import { signPayload } from "@/lib/webhooks/signature";

/*
  Issue #13's acceptance criteria, driven through the real route handler by the
  real fixtures.

  No server is started and no socket is opened. Next 16 route handlers are plain
  functions over the Web Request/Response types, so this is the real handler on
  the real path rather than a stand-in — and the whole file costs nothing to run
  (SPEC.md §10, §3 rule 11).

  What it cannot prove is that a request reaches the handler at all: the route is
  public in proxy.ts, and a route left behind Clerk's session gate would 302
  every delivery to the sign-in page. That is what scripts/replay-webhook.ts is
  for.
*/

const CLERK_ID = "user_test_webhooks_route";
const SECRET = "route-test-retell-webhook-secret";
const APPOINTMENT_STARTS_AT = new Date("2026-08-17T03:30:00.000Z");

/*
  `after()` schedules work to run once the response is sent, which is exactly
  what the route wants and exactly what a test cannot wait for. Collect the
  callbacks instead and let each test flush them, so the assertions run against
  the same code path production takes rather than a directly-called processor.
*/
const { afterCallbacks } = vi.hoisted(() => ({
  afterCallbacks: [] as (() => unknown)[],
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (callback: () => unknown) => {
    afterCallbacks.push(callback);
  },
}));

/** Run everything the handler deferred, the way the platform would. */
async function flushAfter(): Promise<void> {
  const pending = afterCallbacks.splice(0);
  for (const callback of pending) await callback();
}

let seed: ToolTestSeed;

function fixture(name: WebhookFixture): string {
  return webhookFixture(name, {
    retellCallId: seed.retellCallId,
    callzieCallId: seed.callId,
    appointmentId: seed.appointmentId,
  });
}

/** The request Retell would send, signed with the key the route expects. */
async function delivery(
  body: string,
  options: { secret?: string; at?: number; signature?: string | null } = {},
): Promise<Request> {
  const signature =
    options.signature !== undefined
      ? options.signature
      : await signPayload(body, options.secret ?? SECRET, options.at);

  return new Request("http://localhost/api/webhooks/retell", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature === null ? {} : { "x-retell-signature": signature }),
    },
    body,
  });
}

/** Post a fixture and run whatever it deferred. */
async function deliver(name: WebhookFixture): Promise<Response> {
  const response = await webhookRoute(await delivery(fixture(name)));
  await flushAfter();
  return response;
}

async function call() {
  return db.query.calls.findFirst({ where: eq(schema.calls.id, seed.callId) });
}

async function events() {
  return db
    .select()
    .from(schema.webhookEvents)
    .where(eq(schema.webhookEvents.retellCallId, seed.retellCallId));
}

beforeEach(async () => {
  vi.stubEnv("RETELL_WEBHOOK_SECRET", SECRET);
  afterCallbacks.length = 0;
  await cleanupWebhookEvents();
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: APPOINTMENT_STARTS_AT,
    callStatus: "queued",
  });
});

afterEach(async () => {
  await cleanupWebhookEvents();
  await cleanupToolTest(CLERK_ID);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** `webhook_events` has no foreign keys, so it is not in cleanupToolTest. */
async function cleanupWebhookEvents() {
  await db
    .delete(schema.webhookEvents)
    .where(eq(schema.webhookEvents.retellCallId, `call_${CLERK_ID}`));
}

describe("an invalid or missing signature", () => {
  it("is refused with 401 when the header never arrived", async () => {
    const response = await webhookRoute(
      await delivery(fixture("call-started"), { signature: null }),
    );

    expect(response.status).toBe(401);
  });

  it("is refused with 401 when the header is malformed", async () => {
    const response = await webhookRoute(
      await delivery(fixture("call-started"), { signature: "nonsense" }),
    );

    expect(response.status).toBe(401);
  });

  it("is logged, with the reason and nothing else", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await webhookRoute(
      await delivery(fixture("call-started"), { signature: null }),
    );

    expect(logged).toHaveBeenCalledOnce();
    expect(String(logged.mock.calls[0])).toContain("no signature header");
  });

  it("writes nothing at all", async () => {
    await webhookRoute(
      await delivery(fixture("call-ended-completed"), { signature: null }),
    );
    await flushAfter();

    expect(await events()).toHaveLength(0);
    expect((await call())!.status).toBe("queued");
  });

  it("refuses a deployment with no secret configured", async () => {
    const body = fixture("call-started");
    const signature = await signPayload(body, SECRET);
    vi.stubEnv("RETELL_WEBHOOK_SECRET", "");
    vi.stubEnv("RETELL_API_KEY", "");

    const response = await webhookRoute(await delivery(body, { signature }));

    expect(response.status).toBe(401);
  });
});

describe("a forged payload", () => {
  /*
    The async-verify trap, named in the ticket (docs/verification.md A8 point 1).
    `Retell.verify()` is async; negating the un-awaited Promise is always falsy,
    so a handler with that bug returns 200 here and writes the Call row. This
    test is the one that catches it at runtime — lib/webhooks/signature.test.ts
    catches it at compile time.
  */
  it("cannot pass, however well-formed it is", async () => {
    const response = await webhookRoute(
      await delivery(fixture("call-ended-completed"), {
        secret: "an-attackers-own-key",
      }),
    );
    await flushAfter();

    expect(response.status).toBe(401);
    expect((await call())!.status).toBe("queued");
  });

  it("cannot pass by editing a body that was signed honestly", async () => {
    const body = fixture("call-ended-completed");
    const signature = await signPayload(body, SECRET);

    const response = await webhookRoute(
      await delivery(body.replace("user_hangup", "no_valid_payment"), {
        signature,
      }),
    );

    expect(response.status).toBe(401);
  });

  /*
    The 5-minute replay window (A8 point 4). A signature captured off the wire
    stops working, which is why scripts/replay-webhook.ts signs at the moment it
    runs rather than shipping a timestamp inside a fixture.
  */
  it("cannot pass by replaying a signature from six minutes ago", async () => {
    const response = await webhookRoute(
      await delivery(fixture("call-started"), { at: Date.now() - 6 * 60_000 }),
    );

    expect(response.status).toBe(401);
  });

  /*
    A8 point 2: verification must use the raw request body, never a re-serialised
    version. The fixtures are pretty-printed, so a handler that called
    `request.json()` and re-stringified would compute a digest over different
    bytes and refuse its own valid deliveries. This states it outright with a
    body no serialiser would reproduce.
  */
  it("does not stop the raw body being verified byte for byte", async () => {
    const body = `{  "event" : "call_started" ,\n\n  "call" : { "call_id" : "${seed.retellCallId}" }  }`;

    const response = await webhookRoute(await delivery(body));
    await flushAfter();

    expect(response.status).toBe(200);
    expect((await call())!.status).toBe("in_progress");
  });
});

describe("duplicate delivery", () => {
  it("is a no-op and still returns 200", async () => {
    expect((await deliver("call-ended-completed")).status).toBe(200);

    expect((await deliver("call-ended-completed")).status).toBe(200);

    expect(await events()).toHaveLength(1);
  });

  it("leaves the Call exactly where the first delivery put it", async () => {
    await deliver("call-ended-completed");
    const first = await call();

    await deliver("call-ended-completed");

    expect(await call()).toEqual(first);
  });

  /*
    Retell's 10-second timeout means a slow first attempt is redelivered while it
    is still working. That row exists but is unprocessed, and skipping it would
    lose the event — no fourth copy comes after a 200.
  */
  it("still processes a row that was stored but never processed", async () => {
    // A first delivery that stored its row and then died before doing the work.
    await webhookRoute(await delivery(fixture("call-ended-completed")));
    afterCallbacks.length = 0;
    expect((await call())!.status).toBe("queued");

    await deliver("call-ended-completed");

    expect((await call())!.status).toBe("completed");
  });
});

describe("the Call's lifecycle", () => {
  it("runs queued to in progress to completed", async () => {
    expect((await call())!.status).toBe("queued");

    await deliver("call-started");
    expect((await call())!.status).toBe("in_progress");

    await deliver("call-ended-completed");
    expect((await call())!.status).toBe("completed");
  });

  it("captures the duration, the transcript and the recording url", async () => {
    await deliver("call-started");
    await deliver("call-ended-completed");
    // The recording is not on call_ended — A9 records its timing as unverified,
    // so the fixtures carry it on call_analyzed and the receiver takes either.
    await deliver("call-analyzed");

    const row = await call();
    expect(row!.durationSeconds).toBe(95);
    expect(row!.transcript).toContain("Four on Thursday is perfect.");
    expect(row!.recordingUrl).toContain(seed.retellCallId);
  });

  /*
    The per-turn timings issue #16 renders, proved through the real handler
    rather than by calling the parser directly.

    This asserts against the fixture, which is the point: a fixture whose
    `transcript_object` drifted from its `transcript` would pass a unit test
    written to match the parser and fail here. `scripts/replay-webhook.ts`
    drives the same fixture over real HTTP; this is the half of that proof which
    runs without a server, a Cloud SQL proxy or an .env.local.
  */
  it("captures the per-turn timings from call_analyzed", async () => {
    await deliver("call-ended-completed");
    await deliver("call-analyzed");

    const turns = (await call())!.transcriptTurns;

    expect(turns).not.toBeNull();
    expect(turns![0]).toEqual({
      role: "agent",
      content: expect.stringContaining("this is Maya calling from Bloom Salon"),
      startSeconds: 0.32,
    });
    // Six turns in the fixture's transcript, six in its transcript_object.
    expect(turns).toHaveLength(6);
    expect(turns!.map((turn) => turn.role)).toEqual([
      "agent",
      "user",
      "agent",
      "user",
      "agent",
      "user",
    ]);
  });

  it("returns the Appointment to pending when no Tool decided it", async () => {
    await deliver("call-ended-completed");

    const appointment = await db.query.appointments.findFirst({
      where: eq(schema.appointments.id, seed.appointmentId),
    });
    expect(appointment!.status).toBe("pending");
  });
});

describe("disconnection reasons", () => {
  it.each([
    ["call-ended-completed", "completed", "user_hangup"],
    ["call-ended-no-answer", "no_answer", "dial_no_answer"],
    ["call-ended-failed", "failed", "error_user_not_joined"],
  ] as const)("map %s to %s", async (name, status, reason) => {
    await deliver(name);

    const row = await call();
    expect(row!.status).toBe(status);
    expect(row!.disconnectReason).toBe(reason);
  });
});

describe("the two failures that are not about this Call", () => {
  /*
    Both are `failed` in the database, and both must read as themselves rather
    than as a generic failure (the ticket's last criterion). The exact reason is
    kept on the row; lib/business/call-alerts.ts is what turns it into something
    a person sees.
  */
  it("keeps an exhausted Retell balance distinct", async () => {
    await deliver("call-ended-credit-exhausted");

    const row = await call();
    expect(row!.status).toBe("failed");
    expect(row!.disconnectReason).toBe("no_valid_payment");
  });

  it("keeps a concurrency limit distinct", async () => {
    await deliver("call-ended-concurrency");

    const row = await call();
    expect(row!.status).toBe("failed");
    expect(row!.disconnectReason).toBe("concurrency_limit_reached");
  });
});

describe("a signed body the receiver cannot read", () => {
  /*
    A 400 rather than a 200, even though Retell will retry it three times. A body
    our own key signed and we cannot parse means the contract broke on one side
    or the other, and answering 200 would hide that permanently.
  */
  it("is a 400", async () => {
    const response = await webhookRoute(await delivery("<html>not json</html>"));

    expect(response.status).toBe(400);
  });

  it("is a 400 when the envelope has no call id", async () => {
    const response = await webhookRoute(
      await delivery(JSON.stringify({ event: "call_ended", call: {} })),
    );

    expect(response.status).toBe(400);
  });

  it("stores nothing", async () => {
    await webhookRoute(await delivery("<html>not json</html>"));

    expect(await events()).toHaveLength(0);
  });
});

describe("a delivery for a Call Callzie does not have", () => {
  // Retell has nothing to fix by retrying, so this is a 200 with a stored row
  // rather than an error. The row stays unprocessed and stays recoverable.
  it("is accepted and recorded without a crash", async () => {
    const body = JSON.stringify({
      event: "call_ended",
      call: { call_id: "call_nobody_has_ever_seen", disconnection_reason: "user_hangup" },
    });

    const response = await webhookRoute(await delivery(body));
    await flushAfter();

    expect(response.status).toBe(200);
    expect((await call())!.status).toBe("queued");

    await db
      .delete(schema.webhookEvents)
      .where(eq(schema.webhookEvents.retellCallId, "call_nobody_has_ever_seen"));
  });
});
