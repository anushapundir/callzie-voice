import { describe, expect, it } from "vitest";

import { envStatus, type EnvVarStatus } from "@/lib/settings/env-status";

/*
  Pure — `envStatus` takes its environment as an argument, so nothing here reads
  or writes `process.env`. The tests that matter most are the two ways this
  function could betray its purpose: reporting a blank value as configured, and
  letting any part of a secret out.
*/

const row = (rows: EnvVarStatus[], name: string): EnvVarStatus => {
  const found = rows.find((r) => r.name === name);
  if (!found) throw new Error(`${name} is not in the catalogue`);
  return found;
};

describe("envStatus", () => {
  it("reports a variable with a value as set", () => {
    expect(row(envStatus({ DATABASE_URL: "postgresql://x" }), "DATABASE_URL"))
      .toMatchObject({ group: "Database", required: true, set: true });
  });

  it("reports a missing variable as not set", () => {
    expect(row(envStatus({}), "DATABASE_URL").set).toBe(false);
  });

  it("treats an empty assignment as not set", () => {
    // `ANTHROPIC_API_KEY=` is what copying .env.example leaves behind, and the
    // case a `name in env` check would call configured.
    expect(row(envStatus({ ANTHROPIC_API_KEY: "" }), "ANTHROPIC_API_KEY").set)
      .toBe(false);
  });

  it("treats a whitespace-only value as not set", () => {
    expect(row(envStatus({ INTERNAL_SECRET: "   \t\n" }), "INTERNAL_SECRET").set)
      .toBe(false);
  });

  it("counts a value that merely has surrounding whitespace as set", () => {
    // A key pasted with a trailing newline is configured, if untidily so —
    // trimming decides emptiness, it does not reject the value.
    expect(row(envStatus({ CLERK_SECRET_KEY: " sk_test_x\n" }), "CLERK_SECRET_KEY").set)
      .toBe(true);
  });

  it("never returns any part of a value", () => {
    const secret = "sk-ant-super-secret-value";
    const rows = envStatus({
      ANTHROPIC_API_KEY: secret,
      DATABASE_URL: "postgresql://user:hunter2@127.0.0.1:5432/callzie",
    });

    // Whole serialised output, so a value smuggled out under any future field
    // name fails this — not just the fields the type has today.
    const serialised = JSON.stringify(rows);
    expect(serialised).not.toContain(secret);
    expect(serialised).not.toContain("hunter2");
    // A prefix names the provider account; a length separates test keys from
    // live ones. Neither may appear either.
    expect(serialised).not.toContain("sk-ant");
    expect(serialised).not.toContain(String(secret.length));

    for (const entry of rows) {
      expect(Object.keys(entry).sort()).toEqual([
        "group",
        "name",
        "required",
        "set",
      ]);
      expect(typeof entry.set).toBe("boolean");
    }
  });

  it("marks every Google variable optional, per ADR-0004", () => {
    // Callzie must be fully functional for a Business that never connects
    // Google, so an unconfigured Google section is a healthy deployment.
    const google = envStatus({}).filter((r) => r.group === "Google");

    expect(google.map((r) => r.name)).toEqual([
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "TOKEN_ENCRYPTION_KEY",
    ]);
    expect(google.every((r) => !r.required)).toBe(true);
  });

  it("marks RETELL_FROM_NUMBER optional but the rest of Retell required", () => {
    // Phone Calls are flagged off by default (SPEC.md §3 rule 9) and the number
    // cannot be bought until Retell KYC clears.
    const rows = envStatus({});

    expect(row(rows, "RETELL_FROM_NUMBER").required).toBe(false);
    expect(row(rows, "RETELL_API_KEY").required).toBe(true);
    expect(row(rows, "RETELL_WEBHOOK_SECRET").required).toBe(true);
  });

  it("omits the variables the running app never reads", () => {
    // GCP_* configure the setup script and the deploy, not the service. Listing
    // them would put permanently red rows on the panel.
    const names = envStatus({}).map((r) => r.name);

    expect(names).not.toContain("GCP_PROJECT_ID");
    expect(names).not.toContain("GCP_REGION");
    expect(names).not.toContain("CLOUDSQL_CONNECTION_NAME");
  });

  it("lists each variable once, under one group", () => {
    const names = envStatus({}).map((r) => r.name);

    expect(names).toEqual([...new Set(names)]);
  });

  it("does not mutate the catalogue between calls", () => {
    // The rows are fresh objects, so a caller that sorts or annotates them
    // cannot change what the next reader of the panel sees.
    const first = envStatus({ APP_URL: "http://localhost:3000" });
    first.length = 0;

    expect(row(envStatus({}), "APP_URL").set).toBe(false);
    expect(envStatus({}).length).toBeGreaterThan(0);
  });
});
