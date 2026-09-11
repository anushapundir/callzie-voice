import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import { encryptSecret } from "@/lib/google/crypto";
import { syncAppointmentToGoogle } from "@/lib/google/sync";
import { cleanupToolTest, seedToolTest } from "@/lib/tools/testing";

/*
  The reconciler decides insert, patch, delete or nothing from the Appointment
  row alone. Each of those four is asserted here, plus the two properties the
  design leans on hardest: running twice changes nothing the second time, and a
  lost insert race never leaves an event orphaned on somebody's real calendar.

  No test reaches Google (SPEC.md §3 rule 11). Requests are recorded so a test
  can assert the interesting thing — that some paths make no request at all.
*/

const CLERK_ID = "google-sync-test";
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
/** 14:00 Kolkata on 2026-09-01. */
const STARTS_AT = new Date("2026-09-01T08:30:00Z");

let businessId: string;
let appointmentId: string;

type Recorded = { method: string; url: string; body?: unknown };

/**
 * A fake Google that records every request and answers from a handler.
 *
 * The default answers the happy path: an insert returns an id, a list returns
 * an empty calendar, everything else returns 204.
 */
function fakeGoogle(
  overrides: Partial<{
    insertId: string;
    items: unknown[];
    onRequest: (r: Recorded) => Response | undefined;
  }> = {},
) {
  const requests: Recorded[] = [];

  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    const asString = typeof url === "string" ? url : url.toString();
    const method = init?.method ?? "GET";
    // Only the Calendar API sends JSON. The token endpoint is form-encoded,
    // and parsing that as JSON is how this fake used to swallow every refresh.
    const body =
      init?.body && asString.includes("/calendar/v3/")
        ? JSON.parse(init.body as string)
        : undefined;
    const recorded: Recorded = { method, url: asString, body };
    requests.push(recorded);

    const override = overrides.onRequest?.(recorded);
    if (override) return Promise.resolve(override);

    if (asString.startsWith("https://oauth2.googleapis.com/token")) {
      return Promise.resolve(json({ access_token: "ya29.fresh" }));
    }
    if (method === "POST") {
      return Promise.resolve(json({ id: overrides.insertId ?? "evt-new" }));
    }
    if (method === "GET") {
      return Promise.resolve(json({ items: overrides.items ?? [] }));
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as unknown as typeof fetch;

  return {
    impl,
    requests,
    /** Only the Calendar API calls — the token refresh is noise here. */
    calendar: () =>
      requests.filter((r) => r.url.includes("/calendar/v3/")),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function appointment() {
  const row = await db.query.appointments.findFirst({
    where: eq(schema.appointments.id, appointmentId),
  });
  if (!row) throw new Error("fixture appointment vanished");
  return row;
}

async function setAppointment(
  values: Partial<typeof schema.appointments.$inferInsert>,
): Promise<void> {
  await db
    .update(schema.appointments)
    .set(values)
    .where(eq(schema.appointments.id, appointmentId));
}

async function connect(): Promise<void> {
  await db
    .update(schema.businesses)
    .set({
      googleCalendarId: "owner@example.test",
      googleRefreshToken: encryptSecret("1//refresh", KEY),
      googleAccessLostAt: null,
    })
    .where(eq(schema.businesses.id, businessId));
}

beforeAll(async () => {
  await cleanupToolTest(CLERK_ID);
  const seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: STARTS_AT,
  });
  businessId = seed.businessId;
  appointmentId = seed.appointmentId;
});

afterAll(async () => {
  await cleanupToolTest(CLERK_ID);
});

beforeEach(async () => {
  process.env.GOOGLE_CLIENT_ID = "1234.apps.googleusercontent.example";
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
  process.env.TOKEN_ENCRYPTION_KEY = KEY;

  await connect();
  await setAppointment({
    status: "calling",
    googleEventId: null,
    needsAttentionReason: null,
    collisionEventIds: [],
    startsAt: STARTS_AT,
    endsAt: new Date(STARTS_AT.getTime() + 60 * 60_000),
  });
});

describe("syncAppointmentToGoogle", () => {
  it("inserts an event for a Slot-holding Appointment and stores its id", async () => {
    const google = fakeGoogle({ insertId: "evt-created" });

    await syncAppointmentToGoogle(appointmentId, google.impl);

    const inserts = google.calendar().filter((r) => r.method === "POST");
    expect(inserts).toHaveLength(1);
    // The owner is looking at their own calendar — "Appointment" would tell
    // them nothing.
    expect(inserts[0].body).toMatchObject({
      summary: "Priya Sharma — Haircut",
      start: { dateTime: STARTS_AT.toISOString(), timeZone: "Asia/Kolkata" },
    });
    expect((await appointment()).googleEventId).toBe("evt-created");
  });

  it("patches the existing event when one is already recorded", async () => {
    await setAppointment({ googleEventId: "evt-existing" });
    const google = fakeGoogle();

    await syncAppointmentToGoogle(appointmentId, google.impl);

    expect(google.calendar().filter((r) => r.method === "POST")).toHaveLength(0);
    const patches = google.calendar().filter((r) => r.method === "PATCH");
    expect(patches).toHaveLength(1);
    // Only start and end. Patch semantics leave unspecified fields alone, so
    // sending anything else risks clobbering an owner's own edit.
    expect(Object.keys(patches[0].body as object).sort()).toEqual(["end", "start"]);
    expect((await appointment()).googleEventId).toBe("evt-existing");
  });

  it("deletes the event when the Appointment is cancelled", async () => {
    await setAppointment({ googleEventId: "evt-existing", status: "cancelled" });
    const google = fakeGoogle();

    await syncAppointmentToGoogle(appointmentId, google.impl);

    expect(google.calendar().filter((r) => r.method === "DELETE")).toHaveLength(1);
    expect((await appointment()).googleEventId).toBeNull();
  });

  it("deletes the event when the Appointment is declined", async () => {
    // `declined` and `cancelled` are exactly SLOT_FREEING_STATUSES, which is
    // why this branch is driven by that constant rather than by a list here.
    await setAppointment({ googleEventId: "evt-existing", status: "declined" });
    const google = fakeGoogle();

    await syncAppointmentToGoogle(appointmentId, google.impl);

    expect(google.calendar().filter((r) => r.method === "DELETE")).toHaveLength(1);
  });

  it("does nothing at all for a cancelled Appointment that never had an event", async () => {
    await setAppointment({ status: "cancelled", googleEventId: null });
    const google = fakeGoogle();

    await syncAppointmentToGoogle(appointmentId, google.impl);

    expect(google.requests).toHaveLength(0);
  });

  it("treats a 410 on delete as success", async () => {
    /*
      Google returns 410 Gone for an event that was already deleted and says
      "no further action is necessary". Treating it as an error would make a
      cancelled Appointment retry its delete forever.
    */
    await setAppointment({ googleEventId: "evt-existing", status: "cancelled" });
    const google = fakeGoogle({
      onRequest: (r) =>
        r.method === "DELETE"
          ? json({ error: { message: "Resource has been deleted" } }, 410)
          : undefined,
    });

    await syncAppointmentToGoogle(appointmentId, google.impl);

    expect((await appointment()).googleEventId).toBeNull();
  });

  it("changes nothing the second time it runs", async () => {
    // Idempotence is the whole retry story for work deferred to after().
    const first = fakeGoogle({ insertId: "evt-created" });
    await syncAppointmentToGoogle(appointmentId, first.impl);

    const second = fakeGoogle();
    await syncAppointmentToGoogle(appointmentId, second.impl);

    expect(second.calendar().filter((r) => r.method === "POST")).toHaveLength(0);
    expect(second.calendar().filter((r) => r.method === "PATCH")).toHaveLength(1);
    expect((await appointment()).googleEventId).toBe("evt-created");
  });

  it("deletes the event it just created when it loses the insert race", async () => {
    /*
      Two syncs both read google_event_id as null and both insert. Only one can
      claim the row. Without the compare-and-set the loser's event would sit on
      the owner's real calendar forever, and would then be detected as a
      Collision against the very Appointment it belongs to.

      The race is simulated by writing an id from underneath, between the insert
      and the claim.
    */
    const google = fakeGoogle({
      insertId: "evt-loser",
      onRequest: (r) => {
        if (r.method !== "POST" || !r.url.includes("/calendar/v3/")) return undefined;
        return undefined;
      },
    });

    // The winner gets there first.
    await setAppointment({ googleEventId: "evt-winner" });
    await setAppointment({ googleEventId: null });

    // Claim the row the instant the insert is issued.
    const racing = ((url: string | URL | Request, init?: RequestInit) => {
      const asString = typeof url === "string" ? url : url.toString();
      if ((init?.method ?? "GET") === "POST" && asString.includes("/calendar/v3/")) {
        return setAppointment({ googleEventId: "evt-winner" }).then(() =>
          json({ id: "evt-loser" }),
        );
      }
      return google.impl(url as string, init);
    }) as unknown as typeof fetch;

    await syncAppointmentToGoogle(appointmentId, racing);

    // The winner's id survives, and the loser cleaned up after itself.
    expect((await appointment()).googleEventId).toBe("evt-winner");
    const deletes = google
      .calendar()
      .filter((r) => r.method === "DELETE" && r.url.includes("evt-loser"));
    expect(deletes).toHaveLength(1);
  });

  it("makes no request at all for a Business with no Google connection", async () => {
    /*
      ADR-0004's hard requirement, asserted rather than assumed: "Callzie must
      be fully functional for a Business that never connects Google."
    */
    await db
      .update(schema.businesses)
      .set({ googleRefreshToken: null, googleCalendarId: null })
      .where(eq(schema.businesses.id, businessId));

    const google = fakeGoogle();
    await syncAppointmentToGoogle(appointmentId, google.impl);

    expect(google.requests).toHaveLength(0);
    expect((await appointment()).googleEventId).toBeNull();
  });

  it("raises a Collision when something else is already in the window", async () => {
    // ADR-0004's second read: the owner had already blocked 14:30 out by hand.
    const google = fakeGoogle({
      insertId: "evt-ours",
      items: [
        {
          id: "evt-dentist",
          start: { dateTime: "2026-09-01T09:00:00Z" },
          end: { dateTime: "2026-09-01T09:30:00Z" },
        },
      ],
    });

    await syncAppointmentToGoogle(appointmentId, google.impl);

    const row = await appointment();
    expect(row.needsAttentionReason).toBe("collision");
    expect(row.collisionEventIds).toEqual(["evt-dentist"]);
  });

  it("does not collide with the event it just wrote", async () => {
    const google = fakeGoogle({
      insertId: "evt-ours",
      items: [
        {
          id: "evt-ours",
          start: { dateTime: STARTS_AT.toISOString() },
          end: { dateTime: new Date(STARTS_AT.getTime() + 3_600_000).toISOString() },
        },
      ],
    });

    await syncAppointmentToGoogle(appointmentId, google.impl);

    expect((await appointment()).needsAttentionReason).toBeNull();
  });

  it("asks Google for the whole local day, not just the Appointment", async () => {
    /*
      Google does not document how an all-day event is compared against
      timeMin/timeMax, and all-day events raise a Collision here by decision.
      Kolkata midnight around 2026-09-01 is 2026-08-31T18:30Z to
      2026-09-01T18:30Z.
    */
    const google = fakeGoogle();
    await syncAppointmentToGoogle(appointmentId, google.impl);

    const list = google.calendar().find((r) => r.method === "GET");
    const query = new URL(list!.url).searchParams;
    expect(query.get("timeMin")).toBe("2026-08-31T18:30:00.000Z");
    expect(query.get("timeMax")).toBe("2026-09-01T18:30:00.000Z");
    // Without this a recurring meeting comes back as the rule, not the instance.
    expect(query.get("singleEvents")).toBe("true");
  });

  it("writes no Needs Attention row when Google itself fails", async () => {
    /*
      There are four reasons and none of them is "the push failed". A Google
      outage must not fill the surface with rows about Google.
    */
    const google = fakeGoogle({
      onRequest: (r) =>
        r.url.includes("/calendar/v3/")
          ? json({ error: { message: "Backend Error" } }, 500)
          : undefined,
    });

    await syncAppointmentToGoogle(appointmentId, google.impl);

    const row = await appointment();
    expect(row.needsAttentionReason).toBeNull();
    expect(row.googleEventId).toBeNull();
  });
});
