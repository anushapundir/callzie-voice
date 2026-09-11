import { zoneOffsetMs } from "@/lib/time/zone";

/**
 * The IANA timezone catalogue, and the validator that guards writes to it.
 *
 * Deliberately isomorphic — no `"use client"`, no server-only import. The
 * onboarding combobox offers this list in the browser; the Server Action
 * validates what comes back in Node.
 *
 * **The two runtimes do not necessarily agree, and that is the whole design
 * problem here.** `Intl.supportedValuesOf("timeZone")` returns whichever names
 * that runtime's ICU build considers canonical, and builds disagree: Node
 * 22.14 on Windows lists `Asia/Calcutta` and `Asia/Katmandu`, while a newer ICU
 * lists `Asia/Kolkata` and `Asia/Kathmandu`. Since Callzie runs the browser's
 * ICU on one side and the container's on the other, validating a submitted zone
 * by membership in the *server's* list would reject an Indian user's own
 * timezone whenever the two builds differ — with no way for them to proceed.
 *
 * So membership is not the test. `normalizeTimeZone` is: it asks the runtime
 * to resolve the zone, which accepts canonical ids and link names alike, and
 * stores back whatever that runtime calls it. See ADR-0007.
 */

let cached: readonly string[] | null = null;

/**
 * Every timezone this runtime lists, sorted — the combobox's options.
 *
 * Only ever used to populate a picker, never to validate. Computed fresh by
 * Intl on each call, and the combobox filters it on every keystroke, so it is
 * cached for the life of the process.
 */
export function supportedTimeZones(): readonly string[] {
  cached ??= Object.freeze(Intl.supportedValuesOf("timeZone"));
  return cached;
}

/**
 * The runtime's own name for `value`, or `null` if it cannot resolve it.
 *
 * This is the validator *and* the normaliser, which is why it returns the zone
 * rather than a boolean — the caller is expected to persist what comes back,
 * not what went in. Storing the resolved name keeps `businesses.timezone` in a
 * spelling this deployment can always resolve, and stays valid if a later ICU
 * upgrade renames it, because the old name survives as a link.
 *
 * `Intl.DateTimeFormat` throws `RangeError` on a zone it does not know, which
 * is the only reliable membership test available: it covers link names
 * (`US/Eastern` → `America/New_York`) that no catalogue lists.
 */
export function normalizeTimeZone(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value.trim() })
      .resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * A zone's offset at a given moment as `"+05:30"` — the trailing label in the
 * combobox, which is what makes a list of 400-odd opaque ids scannable.
 *
 * Takes the instant explicitly because the answer changes with DST: rendering
 * `Europe/London` as +00:00 in July would be wrong.
 */
export function offsetLabel(timeZone: string, at: Date): string {
  const totalMinutes = Math.round(zoneOffsetMs(at, timeZone) / 60_000);
  const sign = totalMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(totalMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `${sign}${hours}:${minutes}`;
}
