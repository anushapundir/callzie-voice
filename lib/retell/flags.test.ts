import { describe, expect, it } from "vitest";

import { flagSet, flagValue } from "./flags";

/*
  The regression these guard is not hypothetical: `npm run create-agents --
  --dry-run` provisioned four live Agents because npm removed the flag from argv
  and the script fell through to its default. Every case below distinguishes
  "flag absent" from "flag present via npm", because conflating them is what
  turned a no-op into a write.
*/

const NO_ENV: Record<string, string | undefined> = {};

describe("flagSet", () => {
  it("reads a flag passed directly on argv", () => {
    expect(flagSet(["--dry-run"], "--dry-run", NO_ENV)).toBe(true);
  });

  it("reads a flag npm removed from argv and turned into a config", () => {
    expect(
      flagSet([], "--dry-run", { npm_config_dry_run: "true" }),
    ).toBe(true);
  });

  it("maps dashes to underscores, so --list-voices is found", () => {
    expect(
      flagSet([], "--list-voices", { npm_config_list_voices: "true" }),
    ).toBe(true);
  });

  it("is false when the flag is absent from both sources", () => {
    expect(flagSet([], "--dry-run", NO_ENV)).toBe(false);
  });

  it("treats npm's 'false' as unset, so --no-dry-run cannot arm a dry run", () => {
    expect(flagSet([], "--dry-run", { npm_config_dry_run: "false" })).toBe(
      false,
    );
  });

  it("does not match a different flag with a shared prefix", () => {
    expect(flagSet(["--dry-run-please"], "--dry-run", NO_ENV)).toBe(false);
  });
});

describe("flagValue", () => {
  it("reads the value following the flag on argv", () => {
    expect(flagValue(["--only", "salon"], "--only", NO_ENV)).toBe("salon");
  });

  it("reads the value npm stashed in the environment", () => {
    expect(flagValue([], "--only", { npm_config_only: "clinic" })).toBe(
      "clinic",
    );
  });

  it("prefers argv over a stale npm config", () => {
    expect(
      flagValue(["--only", "salon"], "--only", { npm_config_only: "clinic" }),
    ).toBe("salon");
  });

  it("is null when the flag is absent", () => {
    expect(flagValue([], "--only", NO_ENV)).toBeNull();
  });

  it("is null when the flag ends the arguments", () => {
    expect(flagValue(["--only"], "--only", NO_ENV)).toBeNull();
  });

  it("does not swallow the next flag as its value", () => {
    expect(flagValue(["--only", "--check"], "--only", NO_ENV)).toBeNull();
  });
});
