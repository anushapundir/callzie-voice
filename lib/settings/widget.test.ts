import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { db, schema } from "@/lib/db";
import { rotateWidgetKey, saveWidgetOrigins } from "@/lib/settings/widget";
import { cleanupToolTest, seedToolTest, type ToolTestSeed } from "@/lib/tools/testing";

/*
  Saving the sites the widget may run on (issue #45).

  The origins are the whole security control, so the job here is really to make
  them hard to get wrong: a Business must not end up with a key and no origins,
  and it must not be able to list something that is not an origin.
*/

const CLERK_ID = "user_test_widget_settings";

let seed: ToolTestSeed;

beforeEach(async () => {
  await cleanupToolTest(CLERK_ID);
  seed = await seedToolTest({
    clerkId: CLERK_ID,
    appointmentStartsAt: new Date("2026-09-14T04:30:00.000Z"),
  });
});

afterEach(async () => {
  await cleanupToolTest(CLERK_ID);
});

async function stored() {
  return db.query.businesses.findFirst({
    where: eq(schema.businesses.id, seed.businessId),
    columns: { widgetKey: true, widgetOrigins: true },
  });
}

describe("saveWidgetOrigins", () => {
  it("mints a key on the first save", async () => {
    // Not at signup: an account that never turns the widget on has no key at
    // all, so there is nothing sitting in the database to be guessed at.
    expect((await stored())?.widgetKey).toBeNull();

    const result = await saveWidgetOrigins(seed.businessId, "https://example.com");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.key?.startsWith("czw_")).toBe(true);
  });

  it("keeps the same key on a later save", async () => {
    // Changing which sites the button is on must not break the snippet already
    // pasted into them.
    const first = await saveWidgetOrigins(seed.businessId, "https://example.com");
    const second = await saveWidgetOrigins(
      seed.businessId,
      "https://example.com\nhttps://shop.example.com",
    );

    if (!first.ok || !second.ok) throw new Error("expected both to save");
    expect(second.key).toBe(first.key);
  });

  it("stores the origin only, dropping path and query", async () => {
    // Pasting the full address of your own homepage is the obvious thing to do,
    // and refusing it teaches nobody anything.
    await saveWidgetOrigins(
      seed.businessId,
      "https://Example.com/pricing?utm_source=x",
    );

    expect((await stored())?.widgetOrigins).toEqual(["https://example.com"]);
  });

  it("assumes https when no scheme is given", async () => {
    await saveWidgetOrigins(seed.businessId, "example.com");

    expect((await stored())?.widgetOrigins).toEqual(["https://example.com"]);
  });

  it("accepts several, separated by newlines or commas", async () => {
    await saveWidgetOrigins(
      seed.businessId,
      "https://example.com, https://shop.example.com\nhttps://blog.example.com",
    );

    expect((await stored())?.widgetOrigins).toHaveLength(3);
  });

  it("drops duplicates", async () => {
    await saveWidgetOrigins(
      seed.businessId,
      "https://example.com\nhttps://example.com/\nEXAMPLE.COM",
    );

    expect((await stored())?.widgetOrigins).toEqual(["https://example.com"]);
  });

  it("switches the button off when the list is emptied", async () => {
    /*
      Clears the key too, rather than leaving one with nowhere to use it. "Off"
      should mean the lookup fails, not the check after it — a key that
      authorises nothing is a thing being guessed at for no reason.
    */
    await saveWidgetOrigins(seed.businessId, "https://example.com");
    const result = await saveWidgetOrigins(seed.businessId, "   ");

    expect(result).toEqual({ ok: true, key: null, origins: [] });

    const row = await stored();
    expect(row?.widgetKey).toBeNull();
    expect(row?.widgetOrigins).toEqual([]);
  });

  it("refuses something that is not a website address", async () => {
    const result = await saveWidgetOrigins(seed.businessId, "the front desk");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    /*
      Names the offending entry, because with several on screen "one of these
      is wrong" is not a useful thing to be told.

      The entry is "the", not the whole phrase: the field splits on whitespace
      as well as commas, because people paste lists in both shapes. A sentence
      typed in here therefore fails on its first word, which is a slightly odd
      message for an odd thing to have typed — and far better than the
      alternative, which is `https://the` parsing as a valid origin and being
      saved to the allowlist.
    */
    expect(result.error).toContain('"the"');
  });

  it("refuses a scheme that is not a website", async () => {
    // `file:` and `chrome-extension:` are not sites somebody put a button on.
    const result = await saveWidgetOrigins(seed.businessId, "file:///etc/passwd");

    expect(result.ok).toBe(false);
  });

  it("refuses a list long enough to be a paste", async () => {
    const many = Array.from(
      { length: 11 },
      (_, i) => `https://site-${i}.example.com`,
    ).join("\n");

    const result = await saveWidgetOrigins(seed.businessId, many);

    expect(result.ok).toBe(false);
  });

  it("writes nothing when it refuses", async () => {
    await saveWidgetOrigins(seed.businessId, "https://example.com");
    await saveWidgetOrigins(seed.businessId, "https://example.com\nnot a url");

    // The good save survives; the bad one changed nothing.
    expect((await stored())?.widgetOrigins).toEqual(["https://example.com"]);
  });
});

describe("rotateWidgetKey", () => {
  it("issues a new key and kills the old one immediately", async () => {
    // No grace period and no second active key — a rotation that leaves the
    // leaked key alive for an hour is not a rotation.
    const saved = await saveWidgetOrigins(seed.businessId, "https://example.com");
    if (!saved.ok) throw new Error("expected a save");

    const rotated = await rotateWidgetKey(seed.businessId);

    expect(rotated?.key).toBeTruthy();
    expect(rotated?.key).not.toBe(saved.key);
    expect((await stored())?.widgetKey).toBe(rotated?.key);
  });

  it("leaves the allowed sites alone", async () => {
    // Rotating is about the key. Somebody doing it in a hurry must not also
    // have to re-enter their site list.
    await saveWidgetOrigins(seed.businessId, "https://example.com");
    await rotateWidgetKey(seed.businessId);

    expect((await stored())?.widgetOrigins).toEqual(["https://example.com"]);
  });
});
