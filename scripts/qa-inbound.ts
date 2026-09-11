import { config } from "dotenv";

// Next loads .env.local itself; a plain Node process does not. Same mechanism and
// same reason as scripts/create-agent.ts — and it must run before anything that
// reads env at module scope, which `@/lib/db` does.
config({ path: ".env.local" });

import { writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";

import { eq } from "drizzle-orm";

import { db, schema } from "@/lib/db";
import { flagValue } from "@/lib/retell/flags";
import { newWidgetKey } from "@/lib/widget/authorise";

/*
  Sets an account up so the inbound feature can be tried by hand, and prints
  exactly what to click (issues #43, #44, #45).

  **It changes one Business and nothing else**, and everything it changes is
  something the Settings screen can change too — the emergency number, the
  inbound flag, the widget key and origins. There is no state here that a person
  could not have produced themselves in about two minutes; the script exists
  because doing it by hand four times while testing is tedious, not because it
  can do anything the UI cannot.

  What it deliberately does NOT do:

  - **It never buys a phone number.** That is `npm run provision-number`, it
    costs about $2 a month, and a QA helper is the last thing that should be
    able to start a recurring charge. It attaches a *fictional* number instead
    (the reserved 555-01xx block), which is enough to exercise every code path
    that resolves a Business from a dialled number.
  - **It never places a Call.** SPEC.md §3 rule 11 — real Calls only ever happen
    from an explicit human action.
  - **It never runs migrations.** If the schema is behind, it says so and stops,
    because applying migrations to whatever database `DATABASE_URL` points at is
    not a thing a script called "qa" should do quietly.

  Usage:

    npm run qa-inbound                     # the only Business, or list them
    npm run qa-inbound -- --business <id>  # pick one
    npm run qa-inbound -- --reset          # undo: inbound off, widget off
*/

const QA_EMERGENCY_LINE = "+12025550111";

/*
  The reserved fictional block, from `lib/calls/destination.ts`. Never assigned
  to a real subscriber anywhere, so a dialler pointed at it reaches nobody — and
  the outbound path already refuses to dial it, which is the point of using it
  here rather than inventing a plausible-looking number.
*/
const QA_PHONE_NUMBER = "+12025550190";

function say(line = ""): void {
  console.log(line);
}

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

/** Whether issue #43's migrations have actually been applied here. */
async function schemaIsCurrent(): Promise<boolean> {
  try {
    await db.select({ id: schema.enquiries.id }).from(schema.enquiries).limit(1);
    await db
      .select({ id: schema.phoneNumbers.id })
      .from(schema.phoneNumbers)
      .limit(1);
    return true;
  } catch {
    return false;
  }
}

async function pickBusiness(argv: string[]) {
  const requested = flagValue(argv, "--business");

  const businesses = await db
    .select({
      id: schema.businesses.id,
      name: schema.businesses.name,
      businessType: schema.businesses.businessType,
      timezone: schema.businesses.timezone,
    })
    .from(schema.businesses);

  if (businesses.length === 0) {
    fail(
      "There are no Businesses in this database. Sign up in the app and\n" +
        "    finish onboarding first — this script configures an account, it\n" +
        "    does not create one.",
    );
  }

  if (requested) {
    const found = businesses.find((b) => b.id === requested);
    if (!found) fail(`No Business with id ${requested}.`);
    return found;
  }

  if (businesses.length === 1) return businesses[0];

  say("\n  More than one Business. Pass --business <id>:\n");
  for (const business of businesses) {
    say(`    ${business.id}  ${business.name} (${business.businessType})`);
  }
  say("");
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (!(await schemaIsCurrent())) {
    fail(
      "The database is missing the inbound tables. Run `npm run db:migrate`\n" +
        "    first — and make sure the Cloud SQL Auth Proxy is running, or that\n" +
        "    is the error you will actually be looking at.",
    );
  }

  const business = await pickBusiness(argv);
  const appUrl = process.env.APP_URL ?? "";

  if (argv.includes("--reset")) {
    await db
      .update(schema.businesses)
      .set({ inboundEnabled: false, widgetKey: null, widgetOrigins: [] })
      .where(eq(schema.businesses.id, business.id));

    await db
      .delete(schema.phoneNumbers)
      .where(eq(schema.phoneNumbers.e164, QA_PHONE_NUMBER));

    say(`\n  ${business.name}: inbound off, widget off, QA number removed.\n`);
    return;
  }

  /*
    The origins the widget will be allowed from. Both localhost ports the app
    realistically runs on, plus the deployed origin — so the generated test page
    works whichever you open it against.
  */
  const origins = [
    "http://localhost:3000",
    "http://localhost:3001",
    ...(appUrl ? [new URL(appUrl).origin] : []),
  ];

  const existing = await db.query.businesses.findFirst({
    where: eq(schema.businesses.id, business.id),
    columns: { widgetKey: true },
  });

  const widgetKey = existing?.widgetKey ?? newWidgetKey();

  await db
    .update(schema.businesses)
    .set({
      inboundEnabled: true,
      emergencyLine: QA_EMERGENCY_LINE,
      widgetKey,
      widgetOrigins: origins,
      // Generous, so a testing session does not run out halfway through.
      inboundQuota: 100,
      widgetDailyCap: 100,
    })
    .where(eq(schema.businesses.id, business.id));

  // Idempotent: re-running must not fail on the unique index.
  const attached = await db.query.phoneNumbers.findFirst({
    where: eq(schema.phoneNumbers.e164, QA_PHONE_NUMBER),
  });

  if (!attached) {
    await db
      .insert(schema.phoneNumbers)
      .values({
        businessId: business.id,
        e164: QA_PHONE_NUMBER,
        purpose: "inbound",
      });
  }

  const agents = await db
    .select({ direction: schema.retellAgents.direction })
    .from(schema.retellAgents)
    .where(eq(schema.retellAgents.businessType, business.businessType));

  const hasInboundAgent = agents.some((a) => a.direction === "inbound");

  writeTestPage(appUrl, widgetKey);

  say("");
  say(`  ${business.name} is set up for inbound QA.`);
  say("");
  say(`    Business id     ${business.id}`);
  say(`    Timezone        ${business.timezone}`);
  say(`    Emergency line  ${QA_EMERGENCY_LINE}`);
  say(`    QA number       ${QA_PHONE_NUMBER}  (fictional — reaches nobody)`);
  say(`    Widget key      ${widgetKey}`);
  say(`    Allowed from    ${origins.join(", ")}`);
  say("");

  if (!hasInboundAgent) {
    say("  ! No inbound Agent is provisioned for this Business Type.");
    say("    Run `npm run create-agents` — it now creates eight, not four.");
    say("    Until then every inbound call is declined rather than answered.");
    say("");
  }

  say("  What to try, in order:");
  say("");
  say("   1. npm run dev, then open /settings");
  say("      → 'Answering calls' should be ON, with the emergency number filled in");
  say("      → 'Talk-to-us button' should show a snippet");
  say("");
  say("   2. Open qa/widget-test.html in a browser");
  say("      → a button, bottom right");
  say("      → press it: the AI disclosure appears BEFORE the mic prompt");
  say("      → press Start and talk to Maya");
  say("");
  say("   3. On the call, try each of these:");
  say("      → 'what do you do?'          she reads your real Services");
  say("      → 'can I book something?'    she offers real open Slots");
  say("      → 'I'm in a lot of pain'     she gives the emergency number, ends");
  say("      → 'how much does it cost?'   she refuses to quote a price");
  say("");
  say("   4. Back in the app:");
  say("      → Overview shows an open Enquiry, or the booking in the table");
  say("      → /calls shows the call, marked Incoming");
  say("      → open it: the Enquiry card, the Tool invocations, the transcript");
  say("");
  say("   Undo everything: npm run qa-inbound -- --reset");
  say("");
}

/**
 * Writes a standalone page carrying the real embed snippet.
 *
 * A file on disk rather than a route in the app, deliberately: the widget's
 * whole claim is that it works on *somebody else's* site, and serving it from
 * Callzie's own origin would test the one case that does not matter. Opened
 * from the filesystem it is a genuinely foreign origin, which is also why the
 * page says what to expect when the origin check refuses it.
 */
function writeTestPage(appUrl: string, widgetKey: string): void {
  mkdirSync("qa", { recursive: true });

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Callzie widget — QA page</title>
  <style>
    body { font: 16px/1.6 system-ui, sans-serif; max-width: 40rem;
           margin: 4rem auto; padding: 0 1rem; color: #111 }
    code { background: #f2f2f2; padding: .1rem .3rem; border-radius: 4px }
    .warn { background: #fff4e5; border: 1px solid #f0c48a; padding: 1rem;
            border-radius: 8px }
  </style>
</head>
<body>
  <h1>Not a real business</h1>
  <p>This page exists to test the Callzie widget from an origin that is not
     Callzie. The button is bottom right.</p>

  <div class="warn">
    <strong>If the button does nothing:</strong> opening this file directly gives
    the origin <code>null</code>, which the allowlist correctly refuses. Serve it
    instead so it has a real origin:
    <p><code>npx serve qa</code> &nbsp;then open <code>http://localhost:3000</code></p>
    <p>…or whichever port it prints. That origin has to be one the Business
       listed, which <code>npm run qa-inbound</code> has already done for
       localhost 3000 and 3001.</p>
  </div>

  <h2>What should happen</h2>
  <ol>
    <li>Press the button — a panel opens.</li>
    <li>It tells you this is an AI and that the call is recorded,
        <em>before</em> your browser asks for the microphone.</li>
    <li>Press <strong>Start call</strong> — now the mic prompt appears.</li>
    <li>Maya answers with the business's name.</li>
  </ol>

  <script src="${appUrl}/widget.js" data-callzie-key="${widgetKey}"></script>
</body>
</html>
`;

  writeFileSync("qa/widget-test.html", html, "utf8");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
