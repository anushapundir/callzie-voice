import { symmetric, verify as verifyWithRetell } from "retell-sdk/lib/webhook_auth";

/*
  Retell's webhook signature, both halves of it.

  The scheme, from docs/verification.md A8: HMAC-SHA256 over `rawBody + timestamp`,
  keyed by the API key, presented as `v={timestamp},d={hex}` in the
  `X-Retell-Signature` header, and good for five minutes either side of its own
  timestamp.

  Both functions come from the SDK rather than from `node:crypto`. The crypto is
  not the interesting part — the timing-safe compare and the replay window are,
  and the SDK is the authority on both. `symmetric.sign` takes an explicit
  timestamp, which is what lets the tests produce a signature that is correct and
  six minutes old.

  **The signer lives here, next to the verifier, on purpose.** Nothing in the app
  signs a webhook; only the tests and scripts/replay-webhook.ts do. Keeping the
  pair together is what makes the gate testable without a live Retell — SPEC.md
  §10 requires every webhook path to be driveable for free.
*/

/**
 * Why a delivery was accepted or refused.
 *
 * **Not a boolean, and that is the whole design.** `Retell.verify()` is async.
 * Written `if (!Retell.verify(...))` without an `await` it negates a Promise,
 * which is always falsy, and the handler then accepts every forged payload while
 * looking entirely normal — docs/verification.md A8 lists this first among the
 * things that will bite you.
 *
 * A string union makes that mistake a compile error: TypeScript refuses to
 * compare a `Promise` to `"ok"` because the two have no overlap. The test in
 * signature.test.ts pins it with `@ts-expect-error`, so the return type cannot
 * drift back to a boolean without `npm run typecheck` noticing.
 */
export type Verdict = "ok" | "invalid" | "unconfigured";

/** The 5-minute replay window the SDK enforces, restated for the log line. */
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

/** The header shape: `v={unix milliseconds},d={hex digest}`. */
const HEADER = /^v=(\d+),d=([0-9a-f]+)$/i;

/**
 * The signing secret.
 *
 * `RETELL_WEBHOOK_SECRET` is what SPEC.md §2 names, and it holds **the same
 * string as `RETELL_API_KEY`** — Retell signs with the API key you designate as
 * the webhook key, not with a separate secret (A8 point 3). The fallback means a
 * deployment that set only the API key still verifies rather than silently
 * refusing every delivery.
 */
function configuredSecret(): string | undefined {
  return process.env.RETELL_WEBHOOK_SECRET || process.env.RETELL_API_KEY;
}

/**
 * Sign a body the way Retell signs it.
 *
 * `at` exists for the tests and for nothing else: a signature is only good for
 * five minutes, so scripts/replay-webhook.ts signs at the moment it runs. A
 * timestamp baked into a fixture would stop working within the hour.
 */
export function signPayload(
  rawBody: string,
  secret: string,
  at?: number,
): Promise<string> {
  return symmetric.sign(rawBody, secret, at);
}

/**
 * Whether this body really came from Retell.
 *
 * The secret is injected with an environment default, the way
 * `lib/tools/auth.ts:55` does it, so tests describe a deployment instead of
 * mutating `process.env`.
 */
export async function verifySignature(
  rawBody: string,
  signature: string | null | undefined,
  secret: string | undefined = configuredSecret(),
): Promise<Verdict> {
  /*
    An unconfigured deployment refuses everything. A blank secret matching a
    blank header would be an open endpoint that looks configured — the same
    reasoning as the Tool endpoints, and the reason this is checked before the
    header rather than after.
  */
  if (!secret || secret.trim() === "") return "unconfigured";

  if (!signature) return "invalid";

  return (await verifyWithRetell(rawBody, secret, signature)) ? "ok" : "invalid";
}

/**
 * Why a signature was refused, in a form fit for a log line.
 *
 * `verify` answers only true or false, so without this every refusal reads
 * "invalid signature" and leaves someone guessing between a wrong key, a clock
 * six minutes out, and a proxy that dropped the header. The three are entirely
 * different problems with entirely different fixes.
 *
 * It re-reads the header shape rather than re-implementing any crypto, and it
 * never repeats the digest — a log that echoes signature material is a log that
 * leaks it.
 */
export function describeSignature(signature: string | null | undefined): string {
  if (!signature) return "no signature header";

  const match = HEADER.exec(signature);
  if (!match) return "malformed signature header";

  if (Math.abs(Date.now() - Number(match[1])) > REPLAY_WINDOW_MS) {
    return "signature timestamp outside the 5-minute window";
  }

  return "signature did not match";
}
