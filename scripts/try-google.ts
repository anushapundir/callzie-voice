/*
  The Google Calendar push, against the real Google.

  Why this exists on top of the test suite. `lib/google/*.test.ts` injects a
  fake `fetch`, so it proves the pipeline: which verb each Appointment state
  deserves, what counts as an overlap, that a cleared Collision stays cleared.
  It cannot prove that the fake is shaped like Google — that the payloads are
  accepted, that a refresh works against a real grant, or that an event actually
  appears where the owner can see it. That is the other half of the acceptance
  criterion and the only thing this script checks.

  It also settles the one thing Google does not document: whether an all-day
  event is returned by a query for part of that day. `lib/google/overlap.ts`
  routes around the uncertainty by asking for whole days, and step 5 below is
  what turns the guess into a recorded fact for docs/verification.md.

    npm run try-google

  No Call, no telephony, no webhook. The Calendar API is free.

  It needs a Business in the database that has connected Google, and the Cloud
  SQL Auth Proxy running (see CLAUDE.md). Everything it creates, it deletes.
*/

import { config } from "dotenv";

// Next loads .env.local itself; a plain Node process does not. Must run before
// anything below reads process.env. Same mechanism as scripts/try-extraction.ts.
config({ path: ".env.local" });

import { and, isNotNull } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { googleCalendarConfigured } from "@/lib/google/config";
import {
  deleteEvent,
  insertEvent,
  listEvents,
  patchEvent,
} from "@/lib/google/events";
import { overlappingEventIds, wholeDayWindow } from "@/lib/google/overlap";
import { accessTokenFor } from "@/lib/google/token";

/** Everything created here, so the cleanup runs even when a step throws. */
const created: string[] = [];

async function main(): Promise<void> {
  if (!googleCalendarConfigured()) {
    throw new Error(
      "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY must all " +
        "be set. ADR-0004 keeps this integration behind that flag.",
    );
  }

  const business = await db.query.businesses.findFirst({
    where: and(isNotNull(schema.businesses.googleRefreshToken)),
    columns: { id: true, name: true, timezone: true },
  });

  if (!business) {
    throw new Error(
      "No Business has connected Google. Connect one from /settings first.",
    );
  }

  console.log(`Business: ${business.name} (${business.timezone})`);

  // ── 1. A real refresh ────────────────────────────────────────────────────
  const access = await accessTokenFor(business.id);
  if (!access) {
    throw new Error(
      "Could not get an access token. If this Business connected more than a " +
        "week ago, the seven-day Testing-status refresh token has expired — " +
        "reconnect at /settings. Check the server log for the exact reason.",
    );
  }
  console.log(`1. Refreshed. Calendar: ${access.calendarId}`);

  const timeZone = business.timezone;
  // Well clear of anything real on the builder's own calendar.
  const start = new Date(Date.now() + 30 * 24 * 60 * 60_000);
  start.setUTCMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 45 * 60_000);

  // ── 2. Insert ────────────────────────────────────────────────────────────
  const ours = await insertEvent({
    ...access,
    summary: "Callzie smoke test — safe to delete",
    startsAt: start,
    endsAt: end,
    timeZone,
  });
  created.push(ours);
  console.log(`2. Inserted ${ours} at ${start.toISOString()}`);

  // ── 3. Read it back ──────────────────────────────────────────────────────
  const window = { id: "smoke", startsAt: start, endsAt: end, googleEventId: ours };
  const span = wholeDayWindow([window], timeZone);
  if (!span) throw new Error("wholeDayWindow returned null for one Appointment");

  const first = await listEvents({ ...access, ...span });
  console.log(
    `3. Listed ${first.length} event(s) that day. Ours present: ${first.some((e) => e.id === ours)}`,
  );

  // ── 4. A real overlap ────────────────────────────────────────────────────
  const clash = await insertEvent({
    ...access,
    summary: "Callzie smoke test — deliberate clash",
    startsAt: new Date(start.getTime() + 15 * 60_000),
    endsAt: new Date(end.getTime() + 15 * 60_000),
    timeZone,
  });
  created.push(clash);

  const withClash = await listEvents({ ...access, ...span });
  const found = overlappingEventIds({ events: withClash, windows: [window], timeZone });
  const hits = found.get("smoke") ?? [];
  console.log(
    `4. Detection found ${hits.length} overlap(s): ${hits.join(", ") || "none"}`,
  );
  if (!hits.includes(clash)) {
    console.error("   ✗ The deliberate clash was NOT detected. That is a bug.");
  }
  if (hits.includes(ours)) {
    console.error("   ✗ Callzie's own event was reported as a clash. That is a bug.");
  }

  // ── 5. The undocumented one ──────────────────────────────────────────────
  /*
    Google publishes no statement about how a date-only event is compared
    against timeMin/timeMax. All-day events raise a Collision by decision, so
    lib/google/overlap.ts asks for whole days rather than depend on this. The
    answer still belongs in docs/verification.md as observed behaviour.
  */
  const day = start.toISOString().slice(0, 10);
  const nextDay = new Date(start.getTime() + 24 * 60 * 60_000)
    .toISOString()
    .slice(0, 10);

  const allDay = await insertAllDay(access, day, nextDay);
  created.push(allDay);

  const partial = await listEvents({
    ...access,
    timeMin: start,
    timeMax: end,
  });
  const returnedByPartialWindow = partial.some((e) => e.id === allDay);
  console.log(
    `5. All-day event returned by a PARTIAL-day window: ${returnedByPartialWindow}`,
  );
  console.log("   ^ Record this in docs/verification.md. It is not documented.");

  const whole = await listEvents({ ...access, ...span });
  console.log(
    `   All-day event returned by a WHOLE-day window: ${whole.some((e) => e.id === allDay)}`,
  );

  // ── 6. Patch ─────────────────────────────────────────────────────────────
  const moved = new Date(start.getTime() + 2 * 60 * 60_000);
  await patchEvent({
    ...access,
    eventId: ours,
    startsAt: moved,
    endsAt: new Date(moved.getTime() + 45 * 60_000),
    timeZone,
  });
  const afterPatch = await listEvents({ ...access, ...span });
  const patched = afterPatch.find((e) => e.id === ours);
  console.log(`6. Patched. Now starts at ${patched?.start?.dateTime ?? "unknown"}`);

  // ── 7. Delete, twice ─────────────────────────────────────────────────────
  await deleteEvent({ ...access, eventId: ours });
  created.splice(created.indexOf(ours), 1);
  console.log("7. Deleted.");

  await deleteEvent({ ...access, eventId: ours });
  console.log("   Deleting it again was handled as success (Google returns 410).");
}

/**
 * An all-day event, which `lib/google/events.ts` has no reason to create.
 *
 * Callzie only ever writes timed events, so `insertEvent` takes instants and
 * nothing else. This is a test-only shape and belongs here rather than widening
 * that module's surface for a case production never reaches.
 */
async function insertAllDay(
  access: { accessToken: string; calendarId: string },
  from: string,
  to: string,
): Promise<string> {
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
      access.calendarId,
    )}/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        summary: "Callzie smoke test — all day",
        // `end.date` is exclusive: one day off is start 25th, end 26th.
        start: { date: from },
        end: { date: to },
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Could not create the all-day event (${response.status})`);
  }

  const body = (await response.json()) as { id: string };
  return body.id;
}

/**
 * Runs whether or not the script succeeded.
 *
 * A leftover event on somebody's real calendar is worse than a failed script:
 * it is silent, it is in the way, and the next run would detect it as a
 * Collision.
 */
async function cleanup(): Promise<void> {
  if (created.length === 0) return;

  const business = await db.query.businesses.findFirst({
    where: isNotNull(schema.businesses.googleRefreshToken),
    columns: { id: true },
  });
  if (!business) return;

  const access = await accessTokenFor(business.id);
  if (!access) {
    console.error(
      `Could not clean up. Delete these by hand: ${created.join(", ")}`,
    );
    return;
  }

  for (const eventId of created) {
    await deleteEvent({ ...access, eventId }).catch((error: unknown) => {
      console.error(`Could not delete ${eventId}`, error);
    });
  }
  console.log(`Cleaned up ${created.length} event(s).`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    process.exit(process.exitCode ?? 0);
  });
