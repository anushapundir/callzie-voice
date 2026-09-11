import type { CalendarEvent } from "@/lib/google/overlap";

/**
 * The four Calendar API calls ADR-0004's one-way push needs, and nothing else.
 *
 * No decisions live here. Which verb an Appointment deserves is
 * `lib/google/sync.ts`; what counts as an overlap is `lib/google/overlap.ts`.
 * This file turns four intentions into four HTTP requests and reports what came
 * back.
 *
 * `fetchImpl` is injected on every function, the same shape `lib/google/oauth.ts`
 * uses and for the same reason: SPEC.md §3 rule 11 forbids tests from placing
 * real Calls, and an API that rate-limits and needs a live human consent is no
 * different. Nothing in the test suite reaches Google.
 *
 * No `googleapis` dependency, matching the judgement in `oauth.ts` — this is
 * four requests' worth of contract against an enormous generated package.
 *
 * **Verified against Google's docs on 2026-08-23** (SPEC.md §3 rule 12); the
 * facts that shaped this file are quoted at their call sites below.
 */

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3/calendars";

/**
 * The events collection for one calendar.
 *
 * `encodeURIComponent` is not decoration. A `calendarId` is usually the owner's
 * email address, so it carries an `@` and often a `+` or a dot — an unencoded
 * one produces a URL that happens to work for most addresses and fails for the
 * one account whose address needs escaping.
 */
function eventsUrl(calendarId: string): string {
  return `${CALENDAR_BASE}/${encodeURIComponent(calendarId)}/events`;
}

/** One event within that collection. */
function eventUrl(calendarId: string, eventId: string): string {
  return `${eventsUrl(calendarId)}/${encodeURIComponent(eventId)}`;
}

function authHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

/**
 * Fails with the status and Google's `error.message`, never the body verbatim.
 *
 * `oauth.ts` explains the rule at length for the token endpoint, where a body
 * can echo the authorisation code. It is applied here too: these messages reach
 * a server log, and a calendar payload carries the owner's real appointments.
 */
async function failureFrom(response: Response, what: string): Promise<Error> {
  const body = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  const detail = body?.error?.message ? `: ${body.error.message}` : "";

  return new Error(`Google ${what} failed (${response.status}${detail})`);
}

/** The half-open span of an event, as Google wants it written. */
type EventTimes = { startsAt: Date; endsAt: Date; timeZone: string };

/**
 * `start` and `end` are the **only** two required properties on `events.insert`.
 *
 * `timeZone` is sent alongside the offset-bearing `dateTime` even though it is
 * optional for a single event. It costs nothing and it is what makes the event
 * read correctly in the Google UI for an owner travelling outside their
 * Business's zone.
 */
function timesBody({ startsAt, endsAt, timeZone }: EventTimes) {
  return {
    start: { dateTime: startsAt.toISOString(), timeZone },
    end: { dateTime: endsAt.toISOString(), timeZone },
  };
}

export type InsertEventInput = EventTimes & {
  accessToken: string;
  calendarId: string;
  /** What the owner reads on their own calendar. */
  summary: string;
};

/** Creates the event and returns Google's id for it. */
export async function insertEvent(
  { accessToken, calendarId, summary, ...times }: InsertEventInput,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(eventsUrl(calendarId), {
    method: "POST",
    headers: authHeaders(accessToken),
    body: JSON.stringify({ summary, ...timesBody(times) }),
  });

  if (!response.ok) throw await failureFrom(response, "events.insert");

  const body = (await response.json().catch(() => null)) as {
    id?: string;
  } | null;

  /*
    A 200 with no id is not a success. Returning early with `undefined` would
    store null in `google_event_id`, and the next sync would insert a *second*
    event rather than patching the first — a duplicate on the owner's real
    calendar, created by the code meant to keep it tidy.
  */
  if (!body?.id) throw new Error("Google events.insert returned no event id");

  return body.id;
}

export type PatchEventInput = EventTimes & {
  accessToken: string;
  calendarId: string;
  eventId: string;
};

/**
 * Moves an existing event to a new time.
 *
 * **Only `start` and `end` are sent.** Google's patch semantics are explicit
 * that "fields that you don't specify in the request remain unchanged", so
 * anything else in this body would be noise at best — and would overwrite an
 * edit the owner had made to their own copy at worst. A Reschedule changes the
 * time and nothing else, so the body says exactly that.
 *
 * Google notes a `patch` costs three quota units against a `get` plus `update`
 * at two, and recommends the latter. One round trip beats two here: the daily
 * quota is nowhere near a constraint for a single Business, and the second
 * request would be a second chance to fail halfway.
 */
export async function patchEvent(
  { accessToken, calendarId, eventId, ...times }: PatchEventInput,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(eventUrl(calendarId, eventId), {
    method: "PATCH",
    headers: authHeaders(accessToken),
    body: JSON.stringify(timesBody(times)),
  });

  if (!response.ok) throw await failureFrom(response, "events.patch");
}

/**
 * Removes the event.
 *
 * **404 and 410 are successes.** Google returns 410 Gone for an event that was
 * already deleted, and says of that case: "For already deleted events, no
 * further action is necessary." 404 covers one that never existed. The goal is
 * that the event is not on the calendar, and in both cases it is not — treating
 * either as an error would mean a cancelled Appointment retried its delete
 * forever.
 *
 * The exact success code for a delete that did something is not documented
 * beyond "an empty response body", which is why this tests `response.ok` rather
 * than a specific number.
 */
export async function deleteEvent(
  {
    accessToken,
    calendarId,
    eventId,
  }: { accessToken: string; calendarId: string; eventId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(eventUrl(calendarId, eventId), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (response.ok || response.status === 404 || response.status === 410) return;

  throw await failureFrom(response, "events.delete");
}

export type ListEventsInput = {
  accessToken: string;
  calendarId: string;
  timeMin: Date;
  timeMax: Date;
};

/**
 * Everything on the calendar overlapping the window.
 *
 * The two bounds are compared against the **opposite** end of each event —
 * `timeMin` is a "lower bound (exclusive) for an event's end time", `timeMax`
 * an "upper bound (exclusive) for an event's start time". That is exactly the
 * half-open overlap test, which is what makes one wide request provably unable
 * to miss anything: nothing overlapping any part of the window can be excluded.
 *
 * **`singleEvents=true` is not optional.** It defaults to false, and left there
 * a weekly recurring meeting comes back as the recurrence *rule* rather than as
 * this week's instance. Its times would be meaningless and the slot it actually
 * occupies would be silently missed — the failure mode where the feature looks
 * fine and detects nothing.
 *
 * `showDeleted` is left at its default of false, so cancelled events are
 * excluded for free. `overlap.ts` filters them anyway.
 */
export async function listEvents(
  { accessToken, calendarId, timeMin, timeMax }: ListEventsInput,
  fetchImpl: typeof fetch = fetch,
): Promise<CalendarEvent[]> {
  const query = new URLSearchParams({
    // RFC3339 with a mandatory timezone offset, which `toISOString` satisfies
    // with its trailing `Z`.
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: "true",
  });

  const response = await fetchImpl(`${eventsUrl(calendarId)}?${query}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) throw await failureFrom(response, "events.list");

  const body = (await response.json().catch(() => null)) as {
    items?: CalendarEvent[];
    nextPageToken?: string;
  } | null;

  /*
    Deliberately not paginated. The default page size is 250 and the widest
    window this asks for is 14 days of one small business's calendar, so a
    second page means something unusual rather than something expected.

    If one ever arrives, use what came back rather than throwing: a partial
    answer that raises some Collisions is better than an exception that raises
    none. The log line is what would make the assumption visible if it stopped
    holding.
  */
  if (body?.nextPageToken) {
    console.warn(
      `Google events.list returned more than one page for ${calendarId}; using the first`,
    );
  }

  return body?.items ?? [];
}
