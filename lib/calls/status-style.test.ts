import { describe, expect, it } from "vitest";

import { CALL_STATUS_STYLES } from "@/lib/calls/status-style";
import { CALL_STATUSES } from "@/lib/db/schema";

/*
  Six Call statuses, six entries. The test exists because the schema's union is
  the real contract (see the comment at the top of lib/db/schema.ts) and a
  status added there without a style here would render an undefined class — a
  pill with no dot and no word.
*/

describe("CALL_STATUS_STYLES", () => {
  it("covers every Call status the schema declares", () => {
    for (const status of CALL_STATUSES) {
      expect(CALL_STATUS_STYLES[status]).toBeDefined();
      expect(CALL_STATUS_STYLES[status].label.length).toBeGreaterThan(0);
      expect(CALL_STATUS_STYLES[status].background).toMatch(/^bg-/);
    }
  });

  it("gives in-progress the live blue — the same signal as the pulsing dot", () => {
    expect(CALL_STATUS_STYLES.in_progress.background).toBe("bg-live");
  });
});
