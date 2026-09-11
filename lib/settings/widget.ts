import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { newWidgetKey } from "@/lib/widget/authorise";

/*
  Turning the Talk-to-us widget on, and saying which sites it works from
  (issue #45).

  The origins are the whole security control, so this module's job is really to
  make them hard to get wrong: a Business cannot end up with a key and no
  origins, and it cannot list something that is not an origin.
*/

export type WidgetSettingsResult =
  | { ok: true; key: string | null; origins: string[] }
  | { ok: false; error: string };

/**
 * How many sites one Business may list.
 *
 * A bound on the shape of the request rather than a product rule, matching
 * `MAX_CSV_ROWS`. A business has a website and maybe a landing page; a hundred
 * entries is somebody pasting a list.
 */
const MAX_ORIGINS = 10;

/**
 * Saves the sites the widget may run on, minting a key if there is not one.
 *
 * **An empty list switches the widget off**, and does so by clearing the key
 * rather than by leaving a key with nowhere to use it. A key that authorises
 * nothing is a thing sitting in the database being guessed at for no reason, and
 * "off" should mean the lookup fails rather than the check after it.
 *
 * Minting on first save rather than at signup, for the same reason: an account
 * that never turns the widget on has no key at all.
 *
 * Origins are normalised through `URL` and stored serialised — scheme, host,
 * port and nothing else. A path or a query is dropped rather than rejected,
 * because pasting the full address of your own homepage is the obvious thing to
 * do and refusing it teaches nobody anything.
 */
export async function saveWidgetOrigins(
  businessId: string,
  raw: string,
): Promise<WidgetSettingsResult> {
  const entries = raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  if (entries.length > MAX_ORIGINS) {
    return {
      ok: false,
      error: `That is more than ${MAX_ORIGINS} sites. List the ones the button is actually on.`,
    };
  }

  const origins: string[] = [];
  for (const entry of entries) {
    const origin = serialise(entry);
    if (!origin) {
      return {
        ok: false,
        error: `"${entry}" is not a website address. Use the full address, like https://example.com`,
      };
    }

    /*
      An http origin is accepted and is worth thinking about before someone
      objects. The widget requests a microphone, and browsers refuse that on an
      insecure origin anyway — so an http entry produces a button that cannot
      work, in the browser, where the visitor can see why. Refusing it here
      would be a second opinion on a decision the platform already makes, and it
      would block `http://localhost` while somebody is trying the thing out.
    */
    if (!origins.includes(origin)) origins.push(origin);
  }

  if (origins.length === 0) {
    await db
      .update(schema.businesses)
      .set({ widgetOrigins: [], widgetKey: null })
      .where(eq(schema.businesses.id, businessId));

    return { ok: true, key: null, origins: [] };
  }

  const existing = await db.query.businesses.findFirst({
    where: eq(schema.businesses.id, businessId),
    columns: { widgetKey: true },
  });

  const key = existing?.widgetKey ?? newWidgetKey();

  await db
    .update(schema.businesses)
    .set({ widgetOrigins: origins, widgetKey: key })
    .where(eq(schema.businesses.id, businessId));

  return { ok: true, key, origins };
}

/**
 * Issues a new key and invalidates the old one.
 *
 * The answer to "our key is on a page it should not be on". There is no
 * grace period and no second active key: the old one stops working the moment
 * this returns, because a rotation that leaves the leaked key alive for an hour
 * is not a rotation.
 *
 * The snippet on every site the business runs has to be updated afterwards. That
 * is the cost, and it is why this is a deliberate button rather than something
 * that happens on a schedule.
 */
export async function rotateWidgetKey(
  businessId: string,
): Promise<{ key: string } | null> {
  const key = newWidgetKey();

  const rows = await db
    .update(schema.businesses)
    .set({ widgetKey: key })
    .where(eq(schema.businesses.id, businessId))
    .returning({ id: schema.businesses.id });

  return rows.length > 0 ? { key } : null;
}

/** `"https://Example.com/pricing?x=1"` -> `"https://example.com"`, or null. */
function serialise(value: string): string | null {
  const withScheme = /^[a-z]+:\/\//i.test(value) ? value : `https://${value}`;

  try {
    const url = new URL(withScheme);
    // Only http(s). A `file:` or `chrome-extension:` origin is not a website
    // somebody put a button on.
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    /*
      The hostname has to look like one, and this is not fussiness.

      Entries are split on whitespace as well as commas, because people paste
      lists in both shapes. That means a sentence typed into the box — "the
      front desk" — arrives as three entries, and `new URL("https://the")`
      parses perfectly happily. Without this check that saves three allowed
      origins and reports success, which is the worst possible outcome for a
      field whose entire job is to be an allowlist.

      A dot, or `localhost`. Nothing else is a site somebody serves a page from.
    */
    if (url.hostname !== "localhost" && !url.hostname.includes(".")) return null;

    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}
