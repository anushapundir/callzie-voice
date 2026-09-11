import { config } from "dotenv";

// Next loads .env.local itself; a plain Node process does not. Same mechanism and
// same reason as scripts/create-agent.ts — and it must run before anything that
// reads env at module scope, which `@/lib/db` does.
config({ path: ".env.local" });

import { flagSet, flagValue } from "@/lib/retell/flags";
import { retellClient } from "@/lib/retell/client";
import { listNumbers } from "@/lib/inbound/numbers";
import { provisionNumber, releaseNumber } from "@/lib/inbound/provision";

/*
  Buys a phone number and points it at a Business (issue #44).

  **A script, not a button, and that is a deliberate refusal.** Callzie is open
  signup. A self-serve control that purchases a recurring $2/month line is the
  same class of risk as arbitrary outbound dialling — the thing SPEC.md §3 rule 9
  exists to prevent — and there is no per-account spending limit behind it. So
  provisioning is an operator action, run by somebody who has read the price,
  exactly as `scripts/create-agent.ts` is.

  It follows that script's shape too: flags read through `lib/retell/flags.ts`
  because npm eats them (see that file), a `--dry-run` that changes nothing, and
  a preflight that refuses rather than half-doing the job.

  Usage:

    npx tsx scripts/provision-number.ts --business <uuid> [--area-code 415]
    npx tsx scripts/provision-number.ts --business <uuid> --list
    npx tsx scripts/provision-number.ts --business <uuid> --release <number-uuid>
*/

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  const businessId = flagValue(argv, "--business");
  if (!businessId) {
    fail(
      "Pass --business <uuid>. It is the `businesses.id` the number will be\n" +
        "    pointed at; a number is per Business, not per deployment.",
    );
  }

  if (flagSet(argv, "--list")) {
    const numbers = await listNumbers(businessId);

    if (numbers.length === 0) {
      console.log("\n  No numbers attached to that Business.\n");
      return;
    }

    console.log("");
    for (const number of numbers) {
      console.log(
        `  ${number.e164.padEnd(16)} ${number.purpose.padEnd(9)} ${
          number.retellNumberId ?? "(not provisioned at Retell)"
        }  ${number.id}`,
      );
    }
    console.log("");
    return;
  }

  const releasing = flagValue(argv, "--release");
  if (releasing) {
    const client = retellClient();

    const result = await releaseNumber({
      businessId,
      numberId: releasing,
      release: async (id) => {
        await client.phoneNumber.delete(id);
      },
    });

    if (!result.ok) fail("No such number on that Business. Nothing was changed.");

    if (!result.releasedAtRetell) {
      /*
        The row is gone and Retell may still hold the number. Loud, because this
        is the state that costs money quietly — $2 a month for a line nothing
        routes to, and no screen in the product will ever mention it again.
      */
      console.warn(
        "\n  ! Callzie has forgotten the number, but Retell was not able to\n" +
          "    release it (or it was never provisioned there). Check the Retell\n" +
          "    dashboard and delete it by hand, or it bills every month.\n",
      );
      return;
    }

    console.log("\n  Released.\n");
    return;
  }

  /*
    The same APP_URL warning `scripts/create-agent.ts` makes, and for the same
    reason: the inbound webhook URL is baked into the number at purchase time,
    and Retell calls it from its own servers. A localhost here buys a number that
    rings and reaches nothing.
  */
  const appUrl = process.env.APP_URL;
  if (!appUrl) {
    fail(
      "APP_URL is not set. It is the origin Retell posts the inbound webhook\n" +
        "    to, and it is frozen into the number at purchase time.",
    );
  }

  if (appUrl.includes("localhost") && !flagSet(argv, "--allow-localhost")) {
    fail(
      `APP_URL is ${appUrl}. Retell calls the inbound webhook from its own\n` +
        "    servers, so this number would ring and reach nothing. Deploy first,\n" +
        "    or pass --allow-localhost if you know what you are doing.",
    );
  }

  const areaCode = flagValue(argv, "--area-code");

  if (flagSet(argv, "--dry-run")) {
    console.log(
      `\n  Would buy a number${areaCode ? ` in area code ${areaCode}` : ""} and\n` +
        `  point it at ${businessId}, with the inbound webhook at\n` +
        `  ${new URL("/api/webhooks/retell/inbound", appUrl).toString()}\n\n` +
        "  This costs about $2 a month, billed whether or not it rings.\n",
    );
    return;
  }

  const client = retellClient();

  const result = await provisionNumber({
    businessId,
    appUrl,
    ...(areaCode ? { areaCode: Number(areaCode) } : {}),
    purchase: async (params) => {
      const bought = await client.phoneNumber.create(params);
      return {
        phone_number: bought.phone_number,
        phone_number_id: bought.phone_number,
      };
    },
  });

  if (result.ok) {
    console.log(
      `\n  ${result.e164} is now this Business's inbound number.\n\n` +
        "  Next: docs/runbooks/inbound-forwarding.md — the business has to\n" +
        "  forward their published line to it, and somebody has to place one\n" +
        "  real test call to prove it took.\n",
    );
    return;
  }

  if (result.orphanedNumber) {
    /*
      Retell bought a number Callzie could not record. Reported rather than
      auto-released — see `lib/inbound/provision.ts` for why a release that
      itself fails would leave nothing anywhere pointing at a billing number.
    */
    fail(
      `Retell sold ${result.orphanedNumber} but Callzie could not record it\n` +
        `    (${result.reason}). THAT NUMBER IS NOW BILLING WITH NOTHING POINTING\n` +
        "    AT IT. Release it in the Retell dashboard, then fix the cause and\n" +
        "    re-run.",
    );
  }

  if (result.reason === "not_enabled") {
    fail(
      "That Business is not answering calls. Turn it on in Settings first —\n" +
        "    it needs an emergency number, which is the point. A number on an\n" +
        "    account that declines every call is $2 a month for nothing.",
    );
  }

  fail(`Could not buy a number: ${result.reason}.`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
