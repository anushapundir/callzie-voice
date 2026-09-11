import { describe, expect, it } from "vitest";

import {
  checkColumns,
  parseCsvRow,
  type CsvRow,
} from "@/lib/appointments/csv-input";

describe("checkColumns", () => {
  it("accepts the four columns in any order and any case", () => {
    const result = checkColumns(["Time", "NAME", " phone ", "Service"]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The map holds each header as it was actually written, so the caller can
    // read the row back by the key PapaParse produced.
    expect(result.map).toEqual({
      name: "NAME",
      phone: " phone ",
      service: "Service",
      time: "Time",
    });
  });

  it("ignores columns it does not know", () => {
    const result = checkColumns(["name", "phone", "service", "time", "notes"]);

    expect(result.ok).toBe(true);
  });

  it("says which columns the file needs when one is missing", () => {
    const result = checkColumns(["forename", "mobile"]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(
      "That file needs columns named name, phone, service and time. " +
        "Found: forename, mobile.",
    );
  });

  it("refuses two columns that mean the same thing", () => {
    // Picking one would silently drop a column the person filled in.
    const result = checkColumns(["name", "Name", "phone", "service", "time"]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(
      'That file has two columns called "name". Keep one.',
    );
  });

  it("refuses a file with no header at all", () => {
    const result = checkColumns([]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("Found: nothing.");
  });
});

const SERVICES = [
  { id: "svc-haircut", name: "Haircut", durationMinutes: 45 },
  { id: "svc-colour", name: "Colour", durationMinutes: 90 },
];

const CONTEXT = { services: SERVICES, timezone: "Asia/Kolkata" };

function row(overrides: Partial<CsvRow> = {}): CsvRow {
  return {
    rowNumber: 2,
    name: "Priya Raman",
    phone: "+1 202 555 0110",
    service: "Haircut",
    time: "2026-08-21 09:30",
    ...overrides,
  };
}

describe("parseCsvRow", () => {
  it("normalises a good row", () => {
    const result = parseCsvRow(row(), CONTEXT);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value.name).toBe("Priya Raman");
    expect(result.value.phoneE164).toBe("+12025550110");
    expect(result.value.serviceId).toBe("svc-haircut");
    // 09:30 in Asia/Kolkata is +05:30, so 04:00 UTC. A half-hour zone, which is
    // the case a conversion that rounds to whole hours gets wrong.
    expect(result.value.startsAt.toISOString()).toBe("2026-08-21T04:00:00.000Z");
  });

  it("matches a Service by name, trimmed and case-insensitively", () => {
    const result = parseCsvRow(row({ service: "  colour " }), CONTEXT);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value.serviceId).toBe("svc-colour");
  });

  it("reports every problem with a row at once", () => {
    // Four problems, one pass. Stopping at the first would make one upload take
    // four rounds of fixing to get clean.
    const result = parseCsvRow(
      row({ name: "", phone: "9820012345", service: "Colur", time: "tuesday" }),
      CONTEXT,
    );

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.reasons).toEqual([
      "Enter the person's name.",
      "Start with the country code, like +44 or +91.",
      'No service called "Colur". Known services: Haircut, Colour.',
      "Write the time as 2026-08-21 09:30.",
    ]);
  });

  it("reuses the phone validator's own wording", () => {
    // The same sentence the quick-add card shows. One validator, one message.
    const result = parseCsvRow(row({ phone: "+44 (0) 20 7946 0018" }), CONTEXT);

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.reasons).toEqual([
      "Drop the 0 in brackets — an international number has no trunk zero. Write +44 20 7946 0018.",
    ]);
  });

  it("accepts the reserved fictional range the Templates seed", () => {
    // #11 will eventually dial exactly these rows, so the validator must take
    // them without special-casing anything.
    const result = parseCsvRow(row({ phone: "+1 202 555 0142" }), CONTEXT);

    expect(result.status).toBe("ok");
  });

  it("refuses an ambiguous Service name rather than picking one", () => {
    // Nothing stops a Business having two Services with the same name. Picking
    // one would book an unknown duration.
    const result = parseCsvRow(row({ service: "Haircut" }), {
      timezone: "Asia/Kolkata",
      services: [
        { id: "svc-a", name: "Haircut", durationMinutes: 45 },
        { id: "svc-b", name: "haircut", durationMinutes: 60 },
      ],
    });

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.reasons).toEqual([
      'Two services are called "Haircut". Rename one in Settings.',
    ]);
  });

  it("refuses a name over the ceiling quick-add uses", () => {
    const result = parseCsvRow(row({ name: "a".repeat(81) }), CONTEXT);

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.reasons).toEqual(["Keep the name under 80 characters."]);
  });

  it("refuses a time carrying its own offset", () => {
    const result = parseCsvRow(
      row({ time: "2026-08-21T09:30:00+05:30" }),
      CONTEXT,
    );

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.reasons).toEqual(["Write the time as 2026-08-21 09:30."]);
  });

  it("asks for each missing field by name", () => {
    const result = parseCsvRow(
      row({ phone: "", service: "", time: "" }),
      CONTEXT,
    );

    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.reasons).toEqual([
      "Enter a phone number.",
      "Enter a service.",
      "Enter a time.",
    ]);
  });

  it("reports a fully blank line as blank, not as four errors", () => {
    // The file is parsed with skipEmptyLines: false so an interior blank line
    // keeps its row number. It must not turn into four complaints.
    const result = parseCsvRow(
      { rowNumber: 6, name: "", phone: " ", service: "", time: "" },
      CONTEXT,
    );

    expect(result.status).toBe("blank");
  });
});
