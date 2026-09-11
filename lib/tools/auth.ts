import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The gate on all four Tool endpoints (issue #10, acceptance criterion 1).
 *
 * These routes are listed as public in `proxy.ts`, which means only that a Clerk
 * session cookie is not the gate. This is — and it is stricter, because Callzie
 * is open signup (SPEC.md §14 rule 9), so a cookie would let any account that
 * exists write to any Appointment.
 *
 * **Two headers are accepted.** `scripts/create-agent.ts` bakes
 * `Authorization: Bearer ${INTERNAL_SECRET}` into every Tool at creation time,
 * but docs/verification.md A12 records it as UNVERIFIED whether Retell forwards
 * that header unmodified, and names `X-Callzie-Secret` as the fallback.
 * Discovering it was stripped means a live call where every Tool 401s, and a
 * re-provisioning of four Agents to find out. Accepting both costs a few lines.
 */

/**
 * The fallback header from docs/verification.md A12. Spelled lower-case because
 * `Headers` matches case-insensitively and this is also the name we document.
 */
export const SECRET_HEADER = "x-callzie-secret";

/** The credential this request presents, from either header, or null. */
function presented(request: Request): string | null {
  const custom = request.headers.get(SECRET_HEADER);
  if (custom !== null && custom !== "") return custom;

  const authorization = request.headers.get("authorization");
  if (authorization === null) return null;

  // Case-insensitive on the scheme: RFC 7235 says the scheme token is, and a
  // proxy that rewrites "Bearer" to "bearer" is not a request to refuse.
  const match = /^Bearer[ ]+(.+)$/i.exec(authorization.trim());
  return match ? match[1] : null;
}

/*
  Hashed before comparing, and this is not belt-and-braces.

  `timingSafeEqual` throws when the two buffers differ in length — so comparing
  raw secrets would turn "wrong length" into an exception and "right length,
  wrong value" into a false, which leaks the length of the real secret to anyone
  who can tell a 500 from a 401. SHA-256 makes every comparison 32 bytes against
  32 bytes, so the only thing observable is whether it matched.
*/
const digest = (value: string) =>
  createHash("sha256").update(value, "utf8").digest();

export function isAuthorised(
  request: Request,
  // Injected rather than read, so tests can describe a deployment without
  // mutating process.env — the same shape lib/settings/env-status.ts uses.
  secret: string | undefined = process.env.INTERNAL_SECRET,
): boolean {
  // An unconfigured deployment refuses everything. A blank secret that matched a
  // blank header would be an open endpoint that looks configured.
  if (!secret || secret.trim() === "") return false;

  const supplied = presented(request);
  if (supplied === null || supplied.trim() === "") return false;

  return timingSafeEqual(digest(supplied), digest(secret));
}
