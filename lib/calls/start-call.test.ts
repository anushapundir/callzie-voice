import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { provisionUser } from "@/lib/auth/provision-user";
import {
  startCall,
  type PhoneCallCreator,
  type WebCallCreator,
} from "@/lib/calls/start-call";
import { db, schema } from "@/lib/db";
import { formatForSpeech } from "@/lib/time/zone";

/*
  Placing a Call — both routes, end to end, without contacting Retell.

  Both creators are injected, so every branch — including the compensating write
  when Retell fails — runs here for nothing. SPEC.md §3 rule 11: no automated
  test places a real Call. That is why even the tests that expect a Web Call
  pass a phone spy: a routing regression must fail an assertion, not reach a
  telephone.
*/

const CLERK_ID = "user_test_start_call";
const OTHER_CLERK_ID = "user_test_start_call_other";
const STARTS_AT = new Date("2026-09-01T03:30:00.000Z");

let businessId: string;
let appointmentId: string;
let otherAppointmentId: string;

/*
  A Retell that always succeeds, and records what it was asked for.

  Each response carries a fresh `call_id`, because `calls.retell_call_id` is
  UNIQUE — two Calls genuinely cannot share one. A fake that returned a constant
  would make every Call after the first fail on the constraint, which is a
  property of the fake rather than of the code under test.
*/
let nextRetellCallId = 0;

function fakeCreator() {
  const calls: {
    agent_id: string;
    retell_llm_dynamic_variables: Record<string, string>;
    metadata: Record<string, string>;
  }[] = [];

  const creator: WebCallCreator = async (params) => {
    calls.push(params);
    nextRetellCallId += 1;
    return {
      call_id: `retell-call-${nextRetellCallId}`,
      access_token: `token-${nextRetellCallId}`,
    };
  };

  return Object.assign(creator, { calls });
}

/** A Retell that is down. */
const throwingCreator: WebCallCreator = async () => {
  throw new Error("503 from Retell");
};

/*
  A Retell phone dialler that always succeeds, and records what it was asked
  for. Fresh `call_id` per response for the same reason as the web fake:
  `calls.retell_call_id` is UNIQUE.
*/
function fakePhoneCreator() {
  const calls: Parameters<PhoneCallCreator>[0][] = [];

  const creator: PhoneCallCreator = async (params) => {
    calls.push(params);
    nextRetellCallId += 1;
    return { call_id: `retell-call-${nextRetellCallId}` };
  };

  return Object.assign(creator, { calls });
}

/** A phone dialler that is down. */
const throwingPhoneCreator: PhoneCallCreator = async () => {
  throw new Error("503 from Retell");
};

/** Turns the flag on for the Business under test. */
async function enablePhoneCalls() {
  await db
    .update(schema.businesses)
    .set({ phoneCallsEnabled: true })
    .where(eq(schema.businesses.id, businessId));
}

/** Gives the Appointment under test a real, dialable number. */
async function setRealNumber(phoneE164 = "+919876543210") {
  await db
    .update(schema.appointments)
    .set({ phoneE164 })
    .where(eq(schema.appointments.id, appointmentId));
}

async function cleanupFor(clerkId: string) {
  const user = await db.query.users.findFirst({
    where: eq(schema.users.clerkId, clerkId),
  });
  if (!user) return;

  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.userId, user.id),
  });
  if (business) {
    const appointments = await db
      .select({ id: schema.appointments.id })
      .from(schema.appointments)
      .where(eq(schema.appointments.businessId, business.id));
    for (const appointment of appointments) {
      await db
        .delete(schema.calls)
        .where(eq(schema.calls.appointmentId, appointment.id));
    }
    await db
      .delete(schema.appointments)
      .where(eq(schema.appointments.businessId, business.id));
    await db
      .delete(schema.services)
      .where(eq(schema.services.businessId, business.id));
    await db
      .delete(schema.businesses)
      .where(eq(schema.businesses.id, business.id));
  }
  await db.delete(schema.users).where(eq(schema.users.clerkId, clerkId));
}

async function cleanup() {
  await cleanupFor(CLERK_ID);
  await cleanupFor(OTHER_CLERK_ID);
  await db.delete(schema.retellAgents);
}

async function seedBusiness(clerkId: string, startsAt: Date) {
  const user = await provisionUser(clerkId, `${clerkId}@example.com`);
  const [business] = await db
    .insert(schema.businesses)
    .values({
      userId: user.id,
      name: "Bandra Dental",
      businessType: "clinic",
      timezone: "Asia/Kolkata",
      callQuota: 5,
      callsUsed: 0,
    })
    .returning();
  const [service] = await db
    .insert(schema.services)
    .values({
      businessId: business.id,
      name: "Cleaning",
      durationMinutes: 30,
    })
    .returning();
  const [appointment] = await db
    .insert(schema.appointments)
    .values({
      businessId: business.id,
      serviceId: service.id,
      name: "Priya Nair",
      phoneE164: "+12025550142",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
    })
    .returning();

  return { business, appointment };
}

beforeEach(async () => {
  await cleanup();

  await db.insert(schema.retellAgents).values({
    businessType: "clinic",
    llmId: "llm_test",
    agentId: "agent_test_clinic",
  });

  const mine = await seedBusiness(CLERK_ID, STARTS_AT);
  businessId = mine.business.id;
  appointmentId = mine.appointment.id;

  const theirs = await seedBusiness(
    OTHER_CLERK_ID,
    new Date("2026-09-02T03:30:00.000Z"),
  );
  otherAppointmentId = theirs.appointment.id;
});

afterEach(cleanup);

async function callsUsed(): Promise<number> {
  const business = await db.query.businesses.findFirst({
    where: eq(schema.businesses.id, businessId),
  });
  return business!.callsUsed;
}

async function callRows() {
  return db
    .select()
    .from(schema.calls)
    .where(eq(schema.calls.appointmentId, appointmentId));
}

async function appointmentStatus(): Promise<string> {
  const appointment = await db.query.appointments.findFirst({
    where: eq(schema.appointments.id, appointmentId),
  });
  return appointment!.status;
}

describe("startCall", () => {
  it("returns the access token the browser needs to join", async () => {
    const result = await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: fakePhoneCreator(),
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.callType === "web" && result.accessToken).toMatch(
      /^token-\d+$/,
    );
  });

  it("writes a Call row, stores the Retell id, and decrements", async () => {
    await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: fakePhoneCreator(),
    });

    const [call] = await callRows();
    expect(call.attempt).toBe(1);
    expect(call.status).toBe("queued");
    expect(call.retellCallId).toMatch(/^retell-call-\d+$/);
    expect(await callsUsed()).toBe(1);
  });

  it("never writes a Phone Call for an unflagged account", async () => {
    // SPEC.md §3 rule 9. The seed leaves `phone_calls_enabled` off, so the only
    // route this account can take is the web one.
    //
    // The dialler is injected even though this test expects it never to run.
    // Without it, a routing regression here would fall through to the real
    // Retell client — the one test guarding "no automated test places a real
    // Call" would be the one that placed it.
    const dialler = fakePhoneCreator();

    await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: dialler,
    });

    const [call] = await callRows();
    expect(call.callType).toBe("web");
    expect(dialler.calls).toHaveLength(0);
  });

  it("sends the right Agent, and all four variables as strings", async () => {
    const creator = fakeCreator();
    await startCall({
      businessId,
      appointmentId,
      createWebCall: creator,
      createPhoneCall: fakePhoneCreator(),
    });

    const [params] = creator.calls;
    expect(params.agent_id).toBe("agent_test_clinic");
    expect(Object.keys(params.retell_llm_dynamic_variables).sort()).toEqual([
      "business_name",
      "name",
      "service",
      "time",
    ]);
    for (const value of Object.values(params.retell_llm_dynamic_variables)) {
      expect(typeof value).toBe("string");
    }
  });

  it("carries the ids on metadata, which every webhook echoes back", async () => {
    const creator = fakeCreator();
    await startCall({
      businessId,
      appointmentId,
      createWebCall: creator,
      createPhoneCall: fakePhoneCreator(),
    });

    const [call] = await callRows();
    expect(creator.calls[0].metadata).toEqual({
      call_id: call.id,
      appointment_id: appointmentId,
    });
  });

  it("moves the Appointment to calling", async () => {
    await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: fakePhoneCreator(),
    });

    expect(await appointmentStatus()).toBe("calling");
  });

  it("numbers a second Call as attempt 2", async () => {
    await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: fakePhoneCreator(),
    });
    await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: fakePhoneCreator(),
    });

    const attempts = (await callRows()).map((c) => c.attempt).sort();
    expect(attempts).toEqual([1, 2]);
  });
});

describe("what it refuses, before spending anything", () => {
  it("refuses an Appointment belonging to another Business", async () => {
    const creator = fakeCreator();

    const result = await startCall({
      businessId,
      appointmentId: otherAppointmentId,
      createWebCall: creator,
      createPhoneCall: fakePhoneCreator(),
    });

    expect(result).toMatchObject({ ok: false, reason: "not_found" });
    expect(creator.calls).toHaveLength(0);
    // Nothing spent on a lookup that should never have resolved.
    expect(await callsUsed()).toBe(0);
  });

  it("refuses when the Quota is gone, without contacting Retell", async () => {
    await db
      .update(schema.businesses)
      .set({ callsUsed: 5 })
      .where(eq(schema.businesses.id, businessId));
    const creator = fakeCreator();

    const result = await startCall({
      businessId,
      appointmentId,
      createWebCall: creator,
      createPhoneCall: fakePhoneCreator(),
    });

    expect(result).toMatchObject({ ok: false, reason: "exhausted" });
    expect(creator.calls).toHaveLength(0);
    // No orphan row: the claim and the insert are one transaction.
    expect(await callRows()).toHaveLength(0);
  });

  it("refuses before claiming when a variable would be blank", async () => {
    // An unset variable renders literally — Maya would say "curly-curly-name".
    await db
      .update(schema.businesses)
      .set({ name: "   " })
      .where(eq(schema.businesses.id, businessId));
    const creator = fakeCreator();

    const result = await startCall({
      businessId,
      appointmentId,
      createWebCall: creator,
      createPhoneCall: fakePhoneCreator(),
    });

    expect(result).toMatchObject({ ok: false, reason: "invalid_variables" });
    expect(creator.calls).toHaveLength(0);
    // Nothing claimed, so there is nothing to give back.
    expect(await callsUsed()).toBe(0);
    expect(await callRows()).toHaveLength(0);
  });

  it("does not limit an admin account", async () => {
    // Acceptance criterion 4, through the whole path rather than the claim alone.
    await db
      .update(schema.businesses)
      .set({ callsUsed: 99, isAdmin: true })
      .where(eq(schema.businesses.id, businessId));

    const result = await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: fakePhoneCreator(),
    });

    expect(result.ok).toBe(true);
    expect(await callsUsed()).toBe(100);
  });
});

describe("when Retell fails", () => {
  it("gives the Quota back, because the failure is ours and provable", async () => {
    const result = await startCall({
      businessId,
      appointmentId,
      createWebCall: throwingCreator,
      // A working dialler, not `throwingPhoneCreator`: if the route ever
      // regressed to phone, this test would still pass with two throwing
      // creators. With a working one it fails, which is the point.
      createPhoneCall: fakePhoneCreator(),
    });

    expect(result).toMatchObject({ ok: false, reason: "retell_failed" });
    expect(await callsUsed()).toBe(0);
  });

  it("keeps the Call row, marked failed, so the attempt is not erased", async () => {
    await startCall({
      businessId,
      appointmentId,
      createWebCall: throwingCreator,
      createPhoneCall: fakePhoneCreator(),
    });

    const [call] = await callRows();
    expect(call.status).toBe("failed");
    expect(call.disconnectReason).toBe("create_web_call_failed");
  });

  it("leaves the Appointment where it was", async () => {
    await startCall({
      businessId,
      appointmentId,
      createWebCall: throwingCreator,
      createPhoneCall: fakePhoneCreator(),
    });

    expect(await appointmentStatus()).toBe("pending");
  });
});

describe("the Quota holds across concurrent Calls", () => {
  it("places five Calls and refuses the sixth, whatever the ordering", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        startCall({
          businessId,
          appointmentId,
          createWebCall: fakeCreator(),
          createPhoneCall: fakePhoneCreator(),
        }),
      ),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    expect(await callsUsed()).toBe(5);
    expect(await callRows()).toHaveLength(5);
  });
});

describe("an Appointment that needs attention", () => {
  it("is refused, with a reason a person can act on", async () => {
    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: "book_failed" })
      .where(eq(schema.appointments.id, appointmentId));

    const result = await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("needs_attention");
    expect(result.message).toContain("Clear it");
  });

  it("costs nothing", async () => {
    /*
      A refusal leaves nothing behind: no Call spent, and no `calls` row for
      the table to count against the Appointment.

      Note what this does NOT prove. The claim and the insert are one
      transaction, so a refusal placed *after* a claim that then rolled back
      would leave exactly this state and pass here too. What pins the ordering
      is the test below, which shows a flagged Appointment is refused for being
      flagged even when the Quota is already gone.
    */
    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: "unreachable" })
      .where(eq(schema.appointments.id, appointmentId));

    await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
    });

    const business = await db.query.businesses.findFirst({
      where: eq(schema.businesses.id, businessId),
    });
    expect(business!.callsUsed).toBe(0);

    const calls = await db
      .select()
      .from(schema.calls)
      .where(eq(schema.calls.appointmentId, appointmentId));
    expect(calls).toHaveLength(0);
  });

  it("is refused for being flagged, not for the Quota being gone", async () => {
    /*
      The ordering, stated by the suite rather than left to someone reading the
      function top to bottom. Both refusals apply here, and the one that wins
      says which check ran first — so a `needs_attention` answer is proof the
      guard sits ahead of `claimCallQuota`.

      It is also the more useful thing to tell somebody. "You've used all your
      calls" would send them off to think about their Quota, when the actual
      reason this row will not dial is a problem they can fix in one click.
    */
    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: "book_failed" })
      .where(eq(schema.appointments.id, appointmentId));
    await db
      .update(schema.businesses)
      .set({ callsUsed: 5 })
      .where(eq(schema.businesses.id, businessId));

    const result = await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
    });

    expect(result).toMatchObject({ ok: false, reason: "needs_attention" });
  });

  it("never contacts Retell", async () => {
    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: "collision" })
      .where(eq(schema.appointments.id, appointmentId));

    const creator = fakeCreator();
    await startCall({ businessId, appointmentId, createWebCall: creator });

    expect(creator.calls).toHaveLength(0);
  });

  it.each([
    "book_failed",
    "collision",
    "negotiation_truncated",
    "unreachable",
  ] as const)("refuses on %s", async (reason) => {
    // All four block. The reason says what happened; none of them is milder
    // than the others as far as calling somebody goes.
    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: reason })
      .where(eq(schema.appointments.id, appointmentId));

    const result = await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
    });

    expect(result.ok).toBe(false);
  });

  it("is callable again once the reason is cleared", async () => {
    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: "book_failed" })
      .where(eq(schema.appointments.id, appointmentId));
    await db
      .update(schema.appointments)
      .set({ needsAttentionReason: null })
      .where(eq(schema.appointments.id, appointmentId));

    const result = await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
    });

    expect(result.ok).toBe(true);
  });
});

describe("startCall on the phone route", () => {
  const ORIGINAL_FROM_NUMBER = process.env.RETELL_FROM_NUMBER;

  beforeEach(() => {
    process.env.RETELL_FROM_NUMBER = "+14157774444";
  });

  afterEach(() => {
    if (ORIGINAL_FROM_NUMBER === undefined) {
      delete process.env.RETELL_FROM_NUMBER;
    } else {
      process.env.RETELL_FROM_NUMBER = ORIGINAL_FROM_NUMBER;
    }
  });

  it("never dials for an account without the flag", async () => {
    await setRealNumber();
    const dialler = fakePhoneCreator();

    const result = await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: dialler,
    });

    // The acceptance criterion, as an assertion: the flag is off, so the
    // dialler is not merely refused — it is never reached.
    expect(dialler.calls).toHaveLength(0);
    expect(result.ok && result.callType).toBe("web");
  });

  it("dials the Appointment's number for a flagged account", async () => {
    await enablePhoneCalls();
    await setRealNumber("+919876543210");
    const dialler = fakePhoneCreator();

    const result = await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: dialler,
    });

    expect(result.ok && result.callType).toBe("phone");
    expect(dialler.calls).toHaveLength(1);
    expect(dialler.calls[0].from_number).toBe("+14157774444");
    expect(dialler.calls[0].to_number).toBe("+919876543210");
    // Not `agent_id` — create-phone-call names it differently
    // (docs/verification.md A6).
    expect(dialler.calls[0].override_agent_id).toBe("agent_test_clinic");
  });

  it("tells Retell to wait for hello, and to listen for Indian English", async () => {
    /*
      The first real Phone Call surfaced both halves of this
      (docs/verification.md A2, 2026-08-22 and 2026-08-25).

      Wait for hello: the carrier can signal "answered" before a person is
      actually listening, so an agent that speaks first talks over the pickup.
      A fixed delay only moves the problem; `start_speaker: "user"` makes Maya
      hold until she hears a voice. The silence fallback stops the other
      failure — a line where nobody ever speaks would otherwise sit mute until
      the call cap, because the inactivity timer only runs after agent speech.

      Indian English: the base Agents transcribe `en-US`. On a US→India call
      that misheard the caller so badly Retell recorded them as silent and hung
      up with `inactivity`. Phone Calls dial +91 numbers, so they override to
      `en-IN` and the accuracy-first transcriber.

      Per-call overrides, not Agent settings, on purpose: the same four Agents
      answer Web Calls, where the microphone audio is clean and Maya greeting
      instantly is the right experience.
    */
    await enablePhoneCalls();
    await setRealNumber();
    const dialler = fakePhoneCreator();

    await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: dialler,
    });

    expect(dialler.calls[0].agent_override).toEqual({
      agent: { language: "en-IN", stt_mode: "accurate" },
      retell_llm: {
        start_speaker: "user",
        begin_after_user_silence_ms: 10_000,
      },
    });
  });

  it("sends Maya the same name and time as a Web Call", async () => {
    await enablePhoneCalls();
    await setRealNumber();
    const dialler = fakePhoneCreator();

    await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: dialler,
    });

    const variables = dialler.calls[0].retell_llm_dynamic_variables;
    expect(variables.name).toBe("Priya Nair");
    expect(variables.business_name).toBe("Bandra Dental");
    expect(variables.service).toBe("Cleaning");
    /*
      Speakable, not the dashboard's abbreviated 24-hour rendering — the two
      formats have opposite goals (lib/time/zone.ts). Asserted against
      `formatForSpeech` itself rather than a literal, so this test pins that the
      phone route uses the same formatter as the web route rather than pinning
      one particular wording of 9am in Asia/Kolkata.
    */
    expect(variables.time).toBe(formatForSpeech(STARTS_AT, "Asia/Kolkata"));
  });

  it("echoes the same metadata a Web Call sends, so #13 needs no branch", async () => {
    await enablePhoneCalls();
    await setRealNumber();
    const dialler = fakePhoneCreator();

    await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: dialler,
    });

    const [call] = await callRows();
    expect(dialler.calls[0].metadata).toEqual({
      call_id: call.id,
      appointment_id: appointmentId,
    });
  });

  it("writes a Call row identical to a Web Call's apart from call_type", async () => {
    await enablePhoneCalls();
    await setRealNumber();

    await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: fakePhoneCreator(),
    });

    const [call] = await callRows();
    expect(call.callType).toBe("phone");
    expect(call.attempt).toBe(1);
    expect(call.status).toBe("queued");
    expect(call.retellCallId).toMatch(/^retell-call-\d+$/);
    expect(await callsUsed()).toBe(1);
    expect(await appointmentStatus()).toBe("calling");
  });

  it("refuses, and spends nothing, when RETELL_FROM_NUMBER is blank", async () => {
    delete process.env.RETELL_FROM_NUMBER;
    await enablePhoneCalls();
    await setRealNumber();
    const dialler = fakePhoneCreator();

    const result = await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: dialler,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("phone_not_configured");
    // The ordering, not just the refusal: the check must sit above the claim.
    expect(dialler.calls).toHaveLength(0);
    expect(await callsUsed()).toBe(0);
    expect(await callRows()).toHaveLength(0);
  });

  it("refuses when RETELL_FROM_NUMBER is only whitespace", async () => {
    // The realistic version of the case above. An unset variable is obvious on
    // a first deploy; a trailing space left in a config field is not, and
    // without the `.trim()` it would be dialled as a from-number.
    process.env.RETELL_FROM_NUMBER = "   ";
    await enablePhoneCalls();
    await setRealNumber();
    const dialler = fakePhoneCreator();

    const result = await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: dialler,
    });

    expect(!result.ok && result.reason).toBe("phone_not_configured");
    expect(dialler.calls).toHaveLength(0);
    expect(await callsUsed()).toBe(0);
    expect(await callRows()).toHaveLength(0);
  });

  it("dials the number that was checked, not the raw column", async () => {
    /*
      `checkDestination` runs its fictional-range check on the normalised form,
      so the dialled number has to be that same normalised form. Dialling
      `appointments.phone_e164` directly would dial a string nothing validated.
    */
    await enablePhoneCalls();
    await setRealNumber("+91 (98765) 43210");
    const dialler = fakePhoneCreator();

    const result = await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: dialler,
    });

    expect(dialler.calls[0].to_number).toBe("+919876543210");
    expect(result.ok && result.callType === "phone" && result.toNumber).toBe(
      "+919876543210",
    );
  });

  it("refuses, and spends nothing, on a seeded fictional number", async () => {
    await enablePhoneCalls();
    // The seed's own number — left as `seedBusiness` wrote it.
    const dialler = fakePhoneCreator();

    const result = await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: dialler,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("phone_number_unusable");
    expect(dialler.calls).toHaveLength(0);
    expect(await callsUsed()).toBe(0);
    expect(await callRows()).toHaveLength(0);
  });

  it("hands the Call back when Retell fails, exactly as the Web Call does", async () => {
    await enablePhoneCalls();
    await setRealNumber();

    const result = await startCall({
      businessId,
      appointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: throwingPhoneCreator,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("retell_failed");

    const [call] = await callRows();
    expect(call.status).toBe("failed");
    expect(call.disconnectReason).toBe("create_phone_call_failed");
    expect(await callsUsed()).toBe(0);
  });

  it("cannot dial another Business's Appointment", async () => {
    await enablePhoneCalls();
    const dialler = fakePhoneCreator();

    const result = await startCall({
      businessId,
      appointmentId: otherAppointmentId,
      createWebCall: fakeCreator(),
      createPhoneCall: dialler,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("not_found");
    expect(dialler.calls).toHaveLength(0);
  });
});
