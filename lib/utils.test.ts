import { describe, expect, it } from "vitest";

import { cn } from "@/lib/utils";

/**
 * `cn` has to know this app's font sizes, and this is the check that it does.
 *
 * The bug it guards against was invisible. `tailwind-merge` decides which class
 * wins a conflict by looking up the group each one belongs to, and it learns
 * those groups from Tailwind's default scale. `app/globals.css` deletes that
 * scale and names its own sizes, so `text-title` is a name the library has
 * never seen — and its guess for an unknown `text-…` is "a colour". That makes
 * `text-text` look like a conflicting colour, and the size is dropped from the
 * output entirely.
 *
 * Nothing errors when that happens. The class is simply not in the HTML, so the
 * element renders at whatever size it inherited: Overview's four figures shipped
 * at 14px where the design called for 32px, and the screen just looked flat.
 *
 * If a new size token is added to globals.css and not to `FONT_SIZES` in
 * lib/utils.ts, one of these fails.
 */
describe("cn", () => {
  const SIZES = [
    "text-table",
    "text-body",
    "text-section",
    "text-page",
    "text-title",
    "text-display",
    "text-display-sm",
    "text-lead",
  ];

  it.each(SIZES)("keeps %s when a colour follows it", (size) => {
    expect(cn(size, "font-medium text-text")).toContain(size);
  });

  it.each(SIZES)("keeps %s when a muted colour follows it", (size) => {
    expect(cn(size, "text-text-muted")).toContain(size);
  });

  it("still lets the later size win when two sizes really do conflict", () => {
    expect(cn("text-body", "text-section")).toBe("text-section");
  });

  it("still lets the later colour win when two colours really do conflict", () => {
    expect(cn("text-text", "text-attention")).toBe("text-attention");
  });

  it("leaves the rest of tailwind-merge alone", () => {
    expect(cn("px-2", "px-4")).toBe("px-4");
    expect(cn("rounded-card", "rounded-control")).toBe("rounded-control");
    expect(cn("rounded-card", "rounded-soft")).toBe("rounded-soft");
  });
});
