import { describe, expect, it } from "vitest";

import {
  deleteEvent,
  insertEvent,
  listEvents,
  patchEvent,
} from "@/lib/google/events";

/*
  The wire format, asserted. SPEC.md §3 rule 12 requires payloads to be verified
  against current Google docs rather than written from memory, and every claim
  these tests pin is quoted in docs/verification.md E2.

  No test reaches Google. `fetchImpl` is injected on every function, the same
  shape lib/google/oauth.ts uses.
*/

const ACCESS = { accessToken: "ya29.token", calendarId: "owner@example.test" };
const STARTS_AT = new Date("2026-09-01T08:30:00Z");
const ENDS_AT = new Date("2026-09-01T09:15:00Z");
const TIMES = { startsAt: STARTS_AT, endsAt: ENDS_AT, timeZone: "Asia/Kolkata" };

type Recorded = { url: string; method: string; headers: Record<string, string>; body?: unknown };

function recorder(response: () => Response) {
  const calls: Recorded[] = [];
  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof url === "string" ? url : url.toString(),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    return Promise.resolve(response());
  }) as unknown as typeof fetch;

  return { impl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("insertEvent", () => {
  it("posts the two required properties and returns the new id", async () => {
    // `start` and `end` are the only properties Google lists as required.
    const { impl, calls } = recorder(() => json({ id: "evt-new" }));

    expect(
      await insertEvent({ ...ACCESS, summary: "Priya — Haircut", ...TIMES }, impl),
    ).toBe("evt-new");

    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers.Authorization).toBe("Bearer ya29.token");
    expect(calls[0].body).toEqual({
      summary: "Priya — Haircut",
      start: { dateTime: STARTS_AT.toISOString(), timeZone: "Asia/Kolkata" },
      end: { dateTime: ENDS_AT.toISOString(), timeZone: "Asia/Kolkata" },
    });
  });

  it("percent-encodes the calendar id in the path", async () => {
    /*
      A calendarId is usually an email address. Left unencoded the URL happens to
      work for most of them and breaks for the one account whose address needs
      escaping — the kind of bug that only appears on somebody else's machine.
    */
    const { impl, calls } = recorder(() => json({ id: "evt-new" }));

    await insertEvent(
      { ...ACCESS, calendarId: "a+b@example.test", summary: "x", ...TIMES },
      impl,
    );

    expect(calls[0].url).toBe(
      "https://www.googleapis.com/calendar/v3/calendars/a%2Bb%40example.test/events",
    );
  });

  it("throws when Google answers 200 with no id", async () => {
    /*
      Returning undefined here would store null in `google_event_id`, and the
      next sync would insert a SECOND event rather than patching the first — a
      duplicate on the owner's real calendar, created by the code meant to keep
      it tidy.
    */
    const { impl } = recorder(() => json({}));

    await expect(
      insertEvent({ ...ACCESS, summary: "x", ...TIMES }, impl),
    ).rejects.toThrow(/no event id/);
  });

  it("reports the status and Google's message, never the body", async () => {
    // The body of a calendar response carries the owner's real appointments,
    // and this message goes to a server log.
    const { impl } = recorder(() =>
      json({ error: { message: "Insufficient Permission" } }, 403),
    );

    await expect(
      insertEvent({ ...ACCESS, summary: "x", ...TIMES }, impl),
    ).rejects.toThrow("Google events.insert failed (403: Insufficient Permission)");
  });
});

describe("patchEvent", () => {
  it("sends only start and end", async () => {
    /*
      Patch semantics leave unspecified fields unchanged, so anything else in
      this body is noise at best — and would overwrite an edit the owner made to
      their own copy at worst. A Reschedule changes the time and nothing else.
    */
    const { impl, calls } = recorder(() => new Response(null, { status: 200 }));

    await patchEvent({ ...ACCESS, eventId: "evt-1", ...TIMES }, impl);

    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toMatch(/\/events\/evt-1$/);
    expect(Object.keys(calls[0].body as object).sort()).toEqual(["end", "start"]);
  });
});

describe("deleteEvent", () => {
  it("succeeds on an empty 204", async () => {
    const { impl, calls } = recorder(() => new Response(null, { status: 204 }));

    await expect(
      deleteEvent({ ...ACCESS, eventId: "evt-1" }, impl),
    ).resolves.toBeUndefined();
    expect(calls[0].method).toBe("DELETE");
  });

  it("treats 410 Gone as success", async () => {
    /*
      Google returns 410 for an event already deleted, and says "no further
      action is necessary". The goal is that the event is not on the calendar,
      and it is not — treating this as an error would make a cancelled
      Appointment retry its delete forever.
    */
    const { impl } = recorder(() =>
      json({ error: { message: "Resource has been deleted" } }, 410),
    );

    await expect(
      deleteEvent({ ...ACCESS, eventId: "evt-1" }, impl),
    ).resolves.toBeUndefined();
  });

  it("treats 404 as success", async () => {
    const { impl } = recorder(() => json({ error: { message: "Not Found" } }, 404));

    await expect(
      deleteEvent({ ...ACCESS, eventId: "evt-1" }, impl),
    ).resolves.toBeUndefined();
  });

  it("still throws on a real failure", async () => {
    // A 500 is not "the event is gone", and swallowing it would silently leave
    // an event on the calendar for an Appointment nobody is coming to.
    const { impl } = recorder(() => json({ error: { message: "Backend Error" } }, 500));

    await expect(
      deleteEvent({ ...ACCESS, eventId: "evt-1" }, impl),
    ).rejects.toThrow(/500/);
  });
});

describe("listEvents", () => {
  it("asks for single events across the window", async () => {
    const { impl, calls } = recorder(() => json({ items: [{ id: "evt-1" }] }));

    const items = await listEvents(
      { ...ACCESS, timeMin: STARTS_AT, timeMax: ENDS_AT },
      impl,
    );

    expect(items).toEqual([{ id: "evt-1" }]);

    const query = new URL(calls[0].url).searchParams;
    // RFC3339 with a mandatory offset, which toISOString's trailing Z satisfies.
    expect(query.get("timeMin")).toBe(STARTS_AT.toISOString());
    expect(query.get("timeMax")).toBe(ENDS_AT.toISOString());
    /*
      The assertion that matters most in this file. `singleEvents` defaults to
      false, and left there a weekly recurring meeting comes back as the
      recurrence RULE rather than this week's instance — so its times are
      meaningless and the slot it occupies is missed. Collision detection would
      look like it worked and quietly find nothing.
    */
    expect(query.get("singleEvents")).toBe("true");
  });

  it("returns an empty list when the calendar has nothing", async () => {
    const { impl } = recorder(() => json({}));

    expect(
      await listEvents({ ...ACCESS, timeMin: STARTS_AT, timeMax: ENDS_AT }, impl),
    ).toEqual([]);
  });

  it("throws when Google refuses the read", async () => {
    const { impl } = recorder(() => json({ error: { message: "Not Found" } }, 404));

    await expect(
      listEvents({ ...ACCESS, timeMin: STARTS_AT, timeMax: ENDS_AT }, impl),
    ).rejects.toThrow("Google events.list failed (404: Not Found)");
  });
});
