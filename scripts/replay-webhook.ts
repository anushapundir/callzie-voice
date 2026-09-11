/*
  The replay suite for issue #13. Drives every webhook fixture over real HTTP,
  correctly signed, exactly as Retell would.

  **SPEC.md §10: all webhook logic must pass via replay before any real Call.**
  That is what this script is for. It costs nothing and places nothing.

  Why it exists on top of app/api/webhooks/retell/route.test.ts. Those tests call
  the route handler directly, so they prove the handler. They cannot prove that a
  request reaches it at all — and a webhook route missing from `isPublicRoute` in
  proxy.ts would 302 every delivery to the sign-in page, which reads as Retell
  silently never calling. This script is the only thing that checks that.

  Run it with the app running and the Cloud SQL Auth Proxy up:

    npm run dev                  # in one terminal
    npm run replay-webhook       # in another

  It creates one throwaway Appointment and a handful of throwaway Calls against
  the first Business it finds, drives every fixture, forces a real book_slot
  failure, then deletes everything it made. It never touches a row it did not
  create.
*/

import { randomUUID } from "node:crypto";

import { config } from "dotenv";
import { and, asc, eq, inArray } from "drizzle-orm";

// Next loads .env.local itself; a plain Node process does not. Same mechanism and
// same reason as scripts/create-agent.ts and vitest.setup.ts. It has to run
// before anything below reads process.env.
config({ path: ".env.local" });

import { clearNeedsAttention } from "@/lib/appointments/clear-attention";
import { db, schema } from "@/lib/db";
import { TOOL_PATHS } from "@/lib/retell/tools";
import { formatInZone } from "@/lib/time/zone";
import { webhookFixture, type WebhookFixture } from "@/lib/webhooks/fixtures";
import { signPayload } from "@/lib/webhooks/signature";

const APP_URL = process.env.APP_URL ?? "http://localhost:3000";

/*
  The signing secret is the API key. SPEC.md §2 names RETELL_WEBHOOK_SECRET and
  docs/verification.md A8 point 3 explains that it holds the same string — Retell
  signs with whichever API key you designate as the webhook key.
*/
const SECRET = process.env.RETELL_WEBHOOK_SECRET || process.env.RETELL_API_KEY;

/** Baked into every Agent by scripts/create-agent.ts. Keep the two in step. */
const WEBHOOK_PATH = "/api/webhooks/retell";

const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

/** Marks the rows this run creates, so cleanup can never over-reach. */
const MARKER = `replay-${randomUUID().slice(0, 8)}`;

/** One of this run's throwaway Calls, known to have a Retell id. */
type ReplayCall = { id: string; retellCallId: string };

let failures = 0;

// ── saying what happened ──────────────────────────────────────────────────

function heading(text: string) {
  console.log(`\n── ${text} ${"─".repeat(Math.max(0, 60 - text.length))}`);
}

/** One assertion, reported rather than thrown, so a run finishes its list. */
function expect(label: string, actual: unknown, wanted: unknown) {
  const ok = String(actual) === String(wanted);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "ok  " : "FAIL"} ${label.padEnd(46)} ${String(actual)}${ok ? "" : `  (wanted ${String(wanted)})`}`,
  );
}

// ── posting ───────────────────────────────────────────────────────────────

/**
 * POST a body to the webhook, signed however the caller asks.
 *
 * `at` defaults to now, and that default is the point: a signature is only good
 * for five minutes either side of its own timestamp (docs/verification.md A8
 * point 4), so a timestamp baked into a fixture would stop working within the
 * hour.
 */
async function post(
  body: string,
  options: { secret?: string; at?: number; signature?: string | null } = {},
): Promise<number> {
  const signature =
    options.signature !== undefined
      ? options.signature
      : await signPayload(body, options.secret ?? SECRET!, options.at);

  const response = await fetch(new URL(WEBHOOK_PATH, APP_URL).toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature === null ? {} : { "x-retell-signature": signature }),
    },
    body,
  });

  if (response.status === 307 || response.status === 302) {
    console.log(
      "    ^ redirected. /api/webhooks is missing from isPublicRoute in proxy.ts.",
    );
  }

  return response.status;
}

/** POST a fixture pointed at one of this run's Calls. */
function deliver(
  name: WebhookFixture,
  call: ReplayCall,
  appointmentId: string,
  options?: Parameters<typeof post>[1],
): Promise<number> {
  return post(
    webhookFixture(name, {
      retellCallId: call.retellCallId,
      callzieCallId: call.id,
      appointmentId,
    }),
    options,
  );
}

// ── waiting ───────────────────────────────────────────────────────────────

/*
  The handler answers 200 and does the work afterwards, in `after()` — that is
  SPEC.md §3 rule 3, and it means the row has not changed yet when the fetch
  resolves. So poll for the state we expect rather than sleeping a fixed amount:
  a sleep is either too short on a cold `next dev` or wasted on a warm one.
*/
async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();

  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    value = await read();
  }

  return value;
}

const readCall = (id: string) => () =>
  db.query.calls.findFirst({ where: eq(schema.calls.id, id) });

/** Wait until the Call reaches a status, then print the row. */
async function settle(id: string, status: string) {
  const row = await waitFor(
    readCall(id),
    (call) => call?.status === status,
  );

  console.log(
    `       status=${row!.status} duration=${row!.durationSeconds ?? "—"}s ` +
      `reason=${row!.disconnectReason ?? "—"} ` +
      `transcript=${row!.transcript ? `${row!.transcript.length} chars` : "—"} ` +
      `recording=${row!.recordingUrl ? "yes" : "—"}`,
  );

  return row!;
}

// ── the run ───────────────────────────────────────────────────────────────

async function main() {
  if (!SECRET) {
    throw new Error(
      "Neither RETELL_WEBHOOK_SECRET nor RETELL_API_KEY is set. The webhook " +
        "refuses every delivery without one — copy the key from " +
        "https://dashboard.retellai.com/ into .env.local.",
    );
  }
  if (!INTERNAL_SECRET) {
    throw new Error(
      "INTERNAL_SECRET is not set. The book_slot failure this script has to " +
        "prove goes through the Tool endpoints, which refuse everything " +
        "without it.",
    );
  }

  const business = await db.query.businesses.findFirst({
    orderBy: asc(schema.businesses.createdAt),
  });
  if (!business) {
    throw new Error("No Business in this database. Sign up and onboard first.");
  }

  const service = await db.query.services.findFirst({
    where: eq(schema.services.businessId, business.id),
  });
  if (!service) throw new Error(`Business "${business.name}" has no Services.`);

  console.log(`Business: ${business.name} (${business.timezone})`);
  console.log(`Service:  ${service.name}, ${service.durationMinutes} minutes`);
  console.log(`App:      ${APP_URL}`);

  /*
    Parked a year out, so it cannot collide with anything real on the calendar.
    appointments_no_overlap would refuse it, and that refusal would look like a
    bug in the receiver rather than in this script.
  */
  const startsAt = new Date(Date.now() + 365 * 86_400_000);

  const [appointment] = await db
    .insert(schema.appointments)
    .values({
      businessId: business.id,
      serviceId: service.id,
      name: MARKER,
      phoneE164: "+919999999999",
      startsAt,
      endsAt: new Date(startsAt.getTime() + service.durationMinutes * 60_000),
      status: "calling",
    })
    .returning();

  /*
    One Call per ending. The dedupe key is (retell_call_id, event_type), so a
    second `call_ended` for the same Retell id is by design a no-op — which is
    exactly what the duplicate step below proves, and exactly why every other
    ending needs its own Call.
  */
  const scenarios = [
    "lifecycle",
    // No "no-answer" here: section 6 builds its own Appointment and its own two
    // Calls, because a no-answer now rewrites the Appointment as well.
    "failed",
    "credit-exhausted",
    "concurrency",
    "book-failure",
  ] as const;

  const calls = Object.fromEntries(
    await Promise.all(
      scenarios.map(async (name, index) => {
        const retellCallId = `call_${MARKER}_${name}`;
        const [call] = await db
          .insert(schema.calls)
          .values({
            businessId: appointment.businessId,
            appointmentId: appointment.id,
            retellCallId,
            callType: "web",
            attempt: index + 1,
            status: "queued",
          })
          .returning({ id: schema.calls.id });
        /*
          `retellCallId` is the string we just wrote, not the column read back.
          The column is nullable — a Call row exists before Retell returns an id
          (lib/calls/start-web-call.ts) — and every fixture here needs a real one.
        */
        return [name, { id: call.id, retellCallId }] as const;
      }),
    ),
  ) as Record<(typeof scenarios)[number], ReplayCall>;

  console.log(`\nThrowaway Appointment at ${formatInZone(startsAt, business.timezone)}`);
  console.log(`${scenarios.length} throwaway Calls, prefix call_${MARKER}\n`);

  try {
    // ── 1. the gate ──────────────────────────────────────────────────────
    heading("Deliveries that must be refused");

    const body = webhookFixture("call-started", {
      retellCallId: calls.lifecycle.retellCallId,
      callzieCallId: calls.lifecycle.id,
      appointmentId: appointment.id,
    });

    expect("no signature header", await post(body, { signature: null }), 401);
    expect("a signature from the wrong key", await post(body, { secret: "not-the-key" }), 401);
    expect(
      "a correct signature six minutes old",
      await post(body, { at: Date.now() - 6 * 60_000 }),
      401,
    );

    // Signed honestly, then edited. The digest covers the bytes, so this fails.
    const honest = await signPayload(body, SECRET);
    expect(
      "a body edited after signing",
      await post(body.replace("call_started", "call_ended"), { signature: honest }),
      401,
    );

    expect(
      "a signed body that is not an event",
      await post("<html>not json</html>"),
      400,
    );

    // Nothing above may have touched the Call.
    const untouched = await db.query.calls.findFirst({
      where: eq(schema.calls.id, calls.lifecycle.id),
    });
    expect("the Call is still queued", untouched!.status, "queued");

    // ── 2. the lifecycle ─────────────────────────────────────────────────
    heading("The lifecycle of one Call");

    expect("call_started", await deliver("call-started", calls.lifecycle, appointment.id), 200);
    await settle(calls.lifecycle.id, "in_progress");

    expect(
      "call_ended (user_hangup)",
      await deliver("call-ended-completed", calls.lifecycle, appointment.id),
      200,
    );
    const completed = await settle(calls.lifecycle.id, "completed");
    expect("duration captured", completed.durationSeconds, 95);
    expect("transcript captured", completed.transcript !== null, true);
    expect("recording not on call_ended", completed.recordingUrl, "null");

    expect(
      "call_analyzed",
      await deliver("call-analyzed", calls.lifecycle, appointment.id),
      200,
    );
    const analyzed = await waitFor(
      readCall(calls.lifecycle.id),
      (call) => call?.recordingUrl !== null,
    );
    expect("recording url filled in", analyzed!.recordingUrl !== null, true);

    /*
      The per-turn timings the Call detail screen stamps each turn with
      (issue #16). Six turns in the fixture's `transcript`, six in its
      `transcript_object`, and the first one starts at 0.32s.

      Asserted here as well as in app/api/webhooks/retell/route.test.ts because
      the two prove different things. The test proves the handler; this proves a
      signed request carrying `transcript_object` reaches it over real HTTP and
      the column comes back populated — which is what SPEC.md §10 asks for.
    */
    expect("per-turn timings captured", analyzed!.transcriptTurns?.length, 6);
    expect(
      "  and the first turn is stamped",
      analyzed!.transcriptTurns?.[0]?.startSeconds,
      0.32,
    );

    // ── 3. duplicate delivery ────────────────────────────────────────────
    heading("Duplicate delivery");

    expect(
      "the same call_ended again",
      await deliver("call-ended-completed", calls.lifecycle, appointment.id),
      200,
    );

    const events = await db
      .select()
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.retellCallId, calls.lifecycle.retellCallId));
    expect("one row per event type, not per delivery", events.length, 3);

    const afterDuplicate = await db.query.calls.findFirst({
      where: eq(schema.calls.id, calls.lifecycle.id),
    });
    expect("the Call is unchanged", afterDuplicate!.recordingUrl, analyzed!.recordingUrl);

    // ── 4. every other ending ────────────────────────────────────────────
    heading("The other endings");

    /*
      `call-ended-no-answer` is deliberately not in this list any more.

      A no-answer now rewrites the Appointment as well as the Call (issue #17) —
      one retry, then unreachable — and every Call in this loop hangs off the
      one shared Appointment. Marking that unreachable here would break the
      book_slot scenario below. Section 6 drives it against its own Appointment.

      Every ending left in this list maps to `failed`, which earns nothing from
      `afterCall`, so the shared Appointment is untouched exactly as before.
    */
    const endings = [
      ["call-ended-failed", "failed", "failed", "error_user_not_joined"],
      [
        "call-ended-credit-exhausted",
        "credit-exhausted",
        "failed",
        "no_valid_payment",
      ],
      [
        "call-ended-concurrency",
        "concurrency",
        "failed",
        "concurrency_limit_reached",
      ],
    ] as const;

    for (const [fixture, scenario, status, reason] of endings) {
      expect(fixture, await deliver(fixture, calls[scenario], appointment.id), 200);
      const row = await settle(calls[scenario].id, status);
      expect(`  ${reason}`, row.disconnectReason, reason);
    }

    /*
      The two that must not read as a generic failure — SPEC.md §11.4 wants
      inline persistent UI for anything a person has to act on, and
      lib/business/call-alerts.ts turns the reason on the newest Call into the
      banner on Overview.
    */
    console.log(
      "\n  The newest Call now ended in concurrency_limit_reached, so Overview\n" +
        "  should be showing the amber \"Too many calls at once\" banner.",
    );

    // ── 5. the book_slot failure, for real ───────────────────────────────
    heading("A book_slot failure, produced rather than asserted");
    await proveBookFailure(
      business.id,
      appointment.id,
      calls["book-failure"],
      startsAt,
    );

    // ── 6. a silence, twice ──────────────────────────────────────────────
    heading("Nobody answers, twice");
    await proveUnreachable(business.id, service.id, service.durationMinutes);
  } finally {
    await cleanup(appointment.id);
  }

  console.log(
    failures === 0
      ? "\nEverything passed. The webhook is safe to point a real Call at.\n"
      : `\n${failures} check${failures === 1 ? "" : "s"} failed.\n`,
  );

  if (failures > 0) process.exitCode = 1;
}

/**
 * The retry chain (issue #17): one silence requeues, the second gives up.
 *
 * On its own Appointment, at its own time, because it ends by marking that
 * Appointment `unreachable` — doing that to the Appointment every other
 * scenario shares would break them. Parked a day past the shared one so
 * `appointments_no_overlap` has nothing to refuse.
 *
 * The replay account has no phone flag, so the requeued Appointment is never
 * dialled and no Quota moves. That is the point: this proves the rule, not the
 * dialler, which is issue #19.
 */
async function proveUnreachable(
  businessId: string,
  serviceId: string,
  durationMinutes: number,
) {
  const startsAt = new Date(Date.now() + 366 * 86_400_000);

  const [appointment] = await db
    .insert(schema.appointments)
    .values({
      businessId,
      serviceId,
      // The same MARKER, so `cleanup` finds it by id and name.
      name: MARKER,
      phoneE164: "+919999999998",
      startsAt,
      endsAt: new Date(startsAt.getTime() + durationMinutes * 60_000),
      status: "calling",
    })
    .returning();

  try {
    for (const attempt of [1, 2] as const) {
      const retellCallId = `call_${MARKER}_retry_${attempt}`;
      const [call] = await db
        .insert(schema.calls)
        .values({
          businessId: appointment.businessId,
          appointmentId: appointment.id,
          retellCallId,
          callType: "phone",
          attempt,
          status: "queued",
        })
        .returning({ id: schema.calls.id });

      expect(
        `attempt ${attempt} ends dial_no_answer`,
        await deliver(
          "call-ended-no-answer",
          { id: call.id, retellCallId },
          appointment.id,
        ),
        200,
      );

      const wanted = attempt === 1 ? "queued" : "unreachable";
      const row = await waitFor(
        () =>
          db.query.appointments.findFirst({
            where: eq(schema.appointments.id, appointment.id),
          }),
        (found) => found?.status === wanted,
      );

      expect(`  the Appointment is ${wanted}`, row!.status, wanted);

      if (attempt === 2) {
        expect("  it needs attention", row!.needsAttentionReason, "unreachable");
        /*
          SPEC.md §14 rule 2, and the reason this whole scenario exists. An
          unanswered phone is not a cancellation: the Slot is still theirs.
        */
        expect(
          "  and it still holds its Slot",
          row!.startsAt.getTime(),
          startsAt.getTime(),
        );

        /*
          And the way back out (issue #15), through the same function the Clear
          button on Overview calls. Worth proving here rather than only in a
          unit test: this is the one route out of a state Callzie will never
          leave on its own, and it has to work on a row a real delivery wrote
          rather than one a test set up.
        */
        await clearNeedsAttention(businessId, appointment.id);

        const cleared = await db.query.appointments.findFirst({
          where: eq(schema.appointments.id, appointment.id),
        });
        expect("  Clear makes it callable again", cleared!.needsAttentionReason, null);
        expect(
          "  without touching the Slot",
          cleared!.startsAt.getTime(),
          startsAt.getTime(),
        );
        /*
          The status stays `unreachable` on purpose. Clearing says a human has
          looked, not that the person turned out to be reachable after all.
        */
        expect("  or the status", cleared!.status, "unreachable");
      }
    }
  } finally {
    await cleanup(appointment.id);
  }
}

/**
 * Force a genuine `book_slot` failure, then close the Call over it.
 *
 * SPEC.md §8's failure is the exclusion constraint refusing because another
 * Call took the Slot first — not a time outside Business Hours, which
 * `lib/tools/book-slot.ts` refuses earlier and more cheaply as `not_offered`,
 * and which never writes `book_failed`.
 *
 * So this offers a Slot, then takes it out from under the booking with a second
 * Appointment, exactly as a concurrent Call would. Producing the failure is the
 * point: a fixture that merely claims a booking failed proves nothing about the
 * code that has to survive it.
 */
async function proveBookFailure(
  businessId: string,
  appointmentId: string,
  call: ReplayCall,
  originalStartsAt: Date,
) {
  const offered = (await callTool("check_availability", call.retellCallId)) as {
    slots?: { slot_start: string; time: string }[];
  };

  const slot = offered.slots?.[0];
  if (!slot) {
    /*
      Print what actually came back. "Nothing open" and "the endpoint refused
      us" look identical from here otherwise, and one of those is a fully-booked
      fortnight while the other is a broken deployment.
    */
    console.log(`  No Slot to lose. check_availability said: ${JSON.stringify(offered)}`);
    console.log(
      "  If that is an empty slots list, the next 14 days are full — check\n" +
        "  Business Hours in Settings. Anything else is a Tool endpoint problem.",
    );
    failures++;
    return;
  }

  console.log(`  Maya offered ${slot.time}. Another Call takes it first.`);

  const service = await db.query.services.findFirst({
    where: eq(schema.services.businessId, businessId),
  });
  const startsAt = new Date(slot.slot_start);

  await db.insert(schema.appointments).values({
    businessId,
    serviceId: service!.id,
    name: `${MARKER}-blocker`,
    phoneE164: "+919999999998",
    startsAt,
    endsAt: new Date(startsAt.getTime() + service!.durationMinutes * 60_000),
    status: "pending",
  });

  const booked = (await callTool("book_slot", call.retellCallId, {
    slot_start: slot.slot_start,
  })) as { ok?: boolean; reason?: string };

  expect("book_slot refuses", booked.ok, false);
  expect("  and says why", booked.reason, "slot_taken");

  const appointment = await db.query.appointments.findFirst({
    where: eq(schema.appointments.id, appointmentId),
  });
  expect("needs_attention_reason", appointment!.needsAttentionReason, "book_failed");
  /*
    SPEC.md §8 step 3: "The Appointment keeps its original Slot." That is about
    the time, not the status — the earlier endings in this run have already
    released this Appointment to `pending`, correctly, and asserting on the
    status would only be re-testing the order these fixtures happen to run in.
  */
  expect(
    "the Appointment keeps its Slot",
    appointment!.startsAt.toISOString(),
    originalStartsAt.toISOString(),
  );

  // Now the Call ends. The webhook must not undo any of that.
  expect(
    "call_ended over the failed booking",
    await deliver("call-ended-completed", call, appointmentId),
    200,
  );
  await settle(call.id, "completed");

  const after = await db.query.appointments.findFirst({
    where: eq(schema.appointments.id, appointmentId),
  });
  expect("still needs attention afterwards", after!.needsAttentionReason, "book_failed");
}

/** One Tool call, shaped as docs/verification.md A12 records Retell's body. */
async function callTool(
  name: keyof typeof TOOL_PATHS,
  retellCallId: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const response = await fetch(new URL(TOOL_PATHS[name], APP_URL).toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${INTERNAL_SECRET}`,
    },
    body: JSON.stringify({
      name,
      call: { call_id: retellCallId, call_type: "web_call", transcript: "" },
      args,
    }),
  });

  return response.json();
}

/** Only ever the rows this run created. The name marker is the guard. */
async function cleanup(appointmentId: string) {
  const calls = await db
    .select({ id: schema.calls.id, retellCallId: schema.calls.retellCallId })
    .from(schema.calls)
    .where(eq(schema.calls.appointmentId, appointmentId));

  const callIds = calls.map((call) => call.id);
  const retellIds = calls
    .map((call) => call.retellCallId)
    .filter((id): id is string => id !== null);

  if (retellIds.length > 0) {
    await db
      .delete(schema.webhookEvents)
      .where(inArray(schema.webhookEvents.retellCallId, retellIds));
  }
  if (callIds.length > 0) {
    /*
      extractions and tool_invocations both reference calls. Inner rows first,
      or the delete below is refused by the foreign key — and since the
      call-analyzed fixture now runs Extraction (issue #14), a replay leaves an
      extraction row behind every time.
    */
    await db
      .delete(schema.extractions)
      .where(inArray(schema.extractions.callId, callIds));
    await db
      .delete(schema.toolInvocations)
      .where(inArray(schema.toolInvocations.callId, callIds));
  }
  await db.delete(schema.calls).where(eq(schema.calls.appointmentId, appointmentId));

  // Both the Appointment being called and the blocker that stole its Slot.
  await db
    .delete(schema.appointments)
    .where(
      and(
        eq(schema.appointments.id, appointmentId),
        eq(schema.appointments.name, MARKER),
      ),
    );
  await db
    .delete(schema.appointments)
    .where(eq(schema.appointments.name, `${MARKER}-blocker`));

  console.log("\nCleaned up.");
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
