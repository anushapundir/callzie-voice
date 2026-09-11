import { describe, expect, it } from "vitest";

import {
  INBOUND_TOOL_NAMES,
  OUTBOUND_TOOL_NAMES,
  TOOL_NAMES,
} from "@/lib/db/schema";
import {
  END_CALL_TOOL,
  TOOL_DESCRIPTIONS,
  TOOL_PARAMETERS,
  TOOL_PATHS,
  customTools,
  toolUrl,
} from "@/lib/retell/tools";

/*
  These need no database and no network — the Tool contract is plain data. They
  run under the same vitest setup as the integration tests, which insists on
  DATABASE_URL; that guard stays as it is, because it protects the tests that
  genuinely need Postgres.

  A fake secret throughout, and no snapshot file anywhere, so a real
  INTERNAL_SECRET can never reach the repo through this suite.
*/
const APP_URL = "https://callzie.example.test";
const SECRET = "test-internal-secret";

describe("the Tool contract", () => {
  // Driven off TOOL_NAMES so a fifth Callzie Tool cannot be added to the schema
  // without a path, a schema and a description arriving with it.
  it.each(TOOL_NAMES)("%s is fully declared", (name) => {
    expect(TOOL_PATHS[name]).toMatch(/^\/api\/tools\/[a-z-]+$/);
    expect(TOOL_DESCRIPTIONS[name].length).toBeGreaterThan(20);
    expect(TOOL_PARAMETERS[name]).toBeDefined();
  });

  it.each(TOOL_NAMES)("%s has a valid JSON Schema", (name) => {
    const schema = TOOL_PARAMETERS[name];

    // Retell's own documented common mistake.
    expect(schema.type).toBe("object");

    // Every required property must exist, or the model is asked for a field the
    // endpoint will never see.
    for (const required of schema.required) {
      expect(Object.keys(schema.properties)).toContain(required);
    }

    for (const property of Object.values(schema.properties)) {
      expect(property.description.length).toBeGreaterThan(10);
    }
  });

  it("book_slot requires slot_start; check_availability requires nothing", () => {
    expect(TOOL_PARAMETERS.book_slot.required).toEqual(["slot_start"]);
    expect(TOOL_PARAMETERS.check_availability.required).toEqual([]);
  });

  it("confirm and cancel take no arguments", () => {
    expect(TOOL_PARAMETERS.confirm_appointment.properties).toEqual({});
    expect(TOOL_PARAMETERS.cancel_appointment.properties).toEqual({});
  });

  /*
    The anti-cross-tenant-write assertion. Identity comes from the `call` object
    Retell sends, never from an argument — if the model could name the row, one
    hallucinated uuid would write to somebody else's Appointment.
  */
  it.each(TOOL_NAMES)("%s accepts no identifier arguments", (name) => {
    const properties = Object.keys(TOOL_PARAMETERS[name].properties);

    for (const forbidden of ["appointment_id", "business_id", "call_id"]) {
      expect(properties).not.toContain(forbidden);
    }
  });

  it("gives every Tool a distinct path", () => {
    const paths = Object.values(TOOL_PATHS);

    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe("customTools", () => {
  const tools = customTools(APP_URL, SECRET);

  it("declares exactly the four outbound Callzie Tools by default", () => {
    /*
      The default, not all of `TOOL_NAMES`. Issue #43 added three inbound Tools
      and made the set an argument — an outbound Agent handed `book_appointment`
      could create Appointments during a confirmation call, so the default has
      to stay the outbound four rather than "everything declared".
    */
    expect(tools.map((tool) => tool.name)).toEqual([...OUTBOUND_TOOL_NAMES]);
  });

  it("gives an inbound Agent the inbound set instead", () => {
    const inbound = customTools(APP_URL, SECRET, [...INBOUND_TOOL_NAMES]);

    expect(inbound.map((tool) => tool.name)).toEqual([...INBOUND_TOOL_NAMES]);
  });

  it("points every Tool at the deployment it was built for", () => {
    for (const tool of tools) {
      expect(tool.url.startsWith(`${APP_URL}/api/tools/`)).toBe(true);
    }
  });

  it("authenticates every Tool", () => {
    for (const tool of tools) {
      expect(tool.headers.Authorization).toBe(`Bearer ${SECRET}`);
    }
  });

  /*
    Retell's default timeout_ms is 120,000 — the whole call cap (SPEC.md §7). A
    Tool allowed to hang that long would eat the entire conversation, so this
    asserts the default was overridden rather than inherited.
  */
  it("caps every Tool well inside the call duration", () => {
    for (const tool of tools) {
      expect(tool.timeout_ms).toBeLessThanOrEqual(10_000);
      expect(tool.timeout_ms).toBeGreaterThanOrEqual(1_000);
    }
  });

  it("speaks a fixed line during the two Tools that take a beat", () => {
    const availability = tools.find((t) => t.name === "check_availability")!;

    expect(availability.speak_during_execution).toBe(true);
    expect(availability.execution_message_type).toBe("static_text");
    expect(availability.execution_message_description).toBeTruthy();

    const confirm = tools.find((t) => t.name === "confirm_appointment")!;

    expect(confirm.speak_during_execution).toBe(false);
  });

  it("always reports the result back to the customer", () => {
    for (const tool of tools) {
      expect(tool.speak_after_execution).toBe(true);
    }
  });

  it("POSTs, so the call object arrives in the body", () => {
    for (const tool of tools) {
      expect(tool.method).toBe("POST");
    }
  });

  it("builds absolute URLs from a deployment origin", () => {
    expect(toolUrl(APP_URL, "book_slot")).toBe(`${APP_URL}/api/tools/book-slot`);

    // Trailing slashes are the normal shape of a Cloud Run URL read back from
    // `gcloud run services describe`, so they must not double up.
    expect(toolUrl("https://x.test/", "book_slot")).toBe(
      "https://x.test/api/tools/book-slot",
    );
  });
});

describe("the end_call tool", () => {
  /*
    Not one of TOOL_NAMES — it writes nothing and is never recorded in
    tool_invocations. It is declared separately, and this test exists so nobody
    "fixes" the four-versus-five mismatch by deleting it: without end_call the
    Agent cannot hang up and every Call bills to the 120s cap.
  */
  it("is not a Callzie Tool", () => {
    expect(TOOL_NAMES).not.toContain(END_CALL_TOOL.name);
    expect(END_CALL_TOOL.type).toBe("end_call");
  });

  it("tells the model every branch that should end the call", () => {
    expect(END_CALL_TOOL.description).toMatch(/voicemail/i);
    expect(END_CALL_TOOL.description).toMatch(/wrong number/i);
  });
});
