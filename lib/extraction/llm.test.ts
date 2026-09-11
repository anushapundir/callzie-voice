import { afterEach, describe, expect, it, vi } from "vitest";

import { anthropicExtractor } from "@/lib/extraction/llm";

/*
  The only part of this file that can be tested without spending money: the
  refusal to run without a key, and that it happens when the client is built
  rather than when the module is imported.
*/

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("anthropicExtractor", () => {
  it("refuses to build without a key, and says which one", () => {
    /*
      The key has to be removed from the environment, not just left unpassed.
      `apiKey` defaults to `process.env.ANTHROPIC_API_KEY`, so passing
      `undefined` selects that default — and `vitest.setup.ts` loads
      `.env.local`, which CLAUDE.md tells every worktree to link. Without this
      stub the test passes only on a machine that has not been set up, which is
      the worst kind of green.
    */
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    expect(() => anthropicExtractor(undefined)).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("refuses a blank key, which is what copying .env.example leaves behind", () => {
    expect(() => anthropicExtractor("   ")).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("builds with a key", () => {
    expect(typeof anthropicExtractor("sk-ant-test")).toBe("function");
  });
});
