import { readFileSync } from "node:fs";

/**
 * The shipped webhook fixtures, loaded as **raw text**.
 *
 * **Test- and script-only.** Nothing under `app/` may import this. It sits in
 * `lib/webhooks/` beside the code it feeds, the way `lib/tools/testing.ts` does,
 * and is not named `*.test.ts` because Vitest would try to run it as a suite.
 *
 * Text, not a parsed object, and that is the point. A signature is computed over
 * the exact bytes of the request body (docs/verification.md A8 point 2), so the
 * caller has to sign and send the same string. Parsing here and re-serialising
 * at the call site is the precise mistake A8 warns about — this way there is
 * nothing to re-serialise.
 *
 * SPEC.md §10 lists "duplicate delivery" among the required fixtures. It is not
 * a file here: a byte-identical copy of another fixture would prove nothing.
 * Duplicate delivery is `call-ended-completed` sent twice, which is what
 * `app/api/webhooks/retell/route.test.ts` and `scripts/replay-webhook.ts` both
 * do.
 */

export const WEBHOOK_FIXTURES = [
  "call-started",
  "call-ended-completed",
  "call-ended-no-answer",
  "call-ended-failed",
  "call-ended-credit-exhausted",
  "call-ended-concurrency",
  "call-analyzed",
] as const;

export type WebhookFixture = (typeof WEBHOOK_FIXTURES)[number];

/**
 * The fixtures for the *other* webhook — the one asked whether to put a caller
 * through (issue #43).
 *
 * Kept apart from `WEBHOOK_FIXTURES` because they are a different shape aimed at
 * a different URL, and they carry different placeholders: an inbound event knows
 * nothing about a Call or an Appointment, because neither exists yet. It knows
 * two phone numbers, and that is the whole of its input.
 *
 * `sms-inbound` is here because Retell's inbound webhook covers text messages on
 * the same URL. Callzie declines them, and the fixture is what proves it declines
 * rather than answering a text with an agent id.
 */
export const INBOUND_FIXTURES = [
  "call-inbound",
  "call-inbound-anonymous",
  "sms-inbound",
] as const;

export type InboundFixture = (typeof INBOUND_FIXTURES)[number];

export type InboundFixtureTarget = {
  /** The number that was dialled — the tenant key. */
  toNumber: string;
  /** The caller. Ignored by `call-inbound-anonymous`, which withholds it. */
  fromNumber: string;
};

export function inboundFixture(
  name: InboundFixture,
  target: InboundFixtureTarget,
): string {
  return readFileSync(`./fixtures/retell/webhooks/${name}.json`, "utf8")
    .replaceAll("TO_NUMBER_PLACEHOLDER", target.toNumber)
    .replaceAll("FROM_NUMBER_PLACEHOLDER", target.fromNumber);
}

/** The rows a fixture has to be pointed at before it means anything. */
export type FixtureTarget = {
  /** Retell's id — what `calls.retell_call_id` holds. */
  retellCallId: string;
  /** `calls.id`, which the real payloads carry in `metadata.call_id`. */
  callzieCallId: string;
  appointmentId: string;
};

export function webhookFixture(
  name: WebhookFixture,
  target: FixtureTarget,
): string {
  return readFileSync(`./fixtures/retell/webhooks/${name}.json`, "utf8")
    .replaceAll("CALL_ID_PLACEHOLDER", target.retellCallId)
    .replaceAll("CALLZIE_CALL_ID_PLACEHOLDER", target.callzieCallId)
    .replaceAll("APPOINTMENT_ID_PLACEHOLDER", target.appointmentId);
}
