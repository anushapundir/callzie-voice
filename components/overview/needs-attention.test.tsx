import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { NeedsAttention } from "@/components/overview/needs-attention";
import type { NeedsAttentionRow } from "@/lib/business/needs-attention";

/*
  What the surface actually puts on the page.

  `renderToStaticMarkup` rather than a testing library, matching
  components/schedule/day-grid.test.tsx: `NeedsAttention` is a synchronous
  Server Component with no state and no effects, so a string of HTML is the whole
  output. The Clear button inside it is a client island and renders as a plain
  <button> here, which is all these assertions need.

  The Server Action module is stubbed because importing it pulls in Clerk, which
  wants a request context no test has.
*/
vi.mock("@/app/(app)/actions", () => ({
  clearAttentionAction: async () => {},
}));

const KOLKATA = "Asia/Kolkata";

const BOOK_FAILED: NeedsAttentionRow = {
  id: "appt-1",
  name: "Priya Sharma",
  startsAt: new Date("2026-08-14T03:30:00.000Z"),
  serviceName: "Cleaning",
  reason: "book_failed",
  attempts: 1,
};

const UNREACHABLE: NeedsAttentionRow = {
  id: "appt-2",
  name: "Daniel Okafor",
  startsAt: new Date("2026-08-14T06:00:00.000Z"),
  serviceName: "Haircut",
  reason: "unreachable",
  attempts: 2,
};

const COLLISION: NeedsAttentionRow = {
  id: "appt-3",
  name: "Ana Silva",
  startsAt: new Date("2026-08-15T10:30:00.000Z"),
  serviceName: "Consultation",
  reason: "collision",
  attempts: 0,
};

function render(rows: NeedsAttentionRow[]): string {
  return renderToStaticMarkup(
    <NeedsAttention rows={rows} timezone={KOLKATA} />,
  );
}

describe("NeedsAttention", () => {
  it("renders nothing at all when there is nothing wrong", () => {
    // SPEC.md §11.3: "only when non-empty". Not an empty state — no section.
    expect(render([])).toBe("");
  });

  /*
    The count and the words are asserted apart because only the figure is amber
    now — it renders as `<span class="text-attention">2</span> appointments need
    attention`, so the heading is no longer one run of text.
  */
  it("counts what is in it", () => {
    const html = render([BOOK_FAILED, UNREACHABLE]);
    expect(html).toContain(">2</span> appointments need attention");
  });

  it("says one appointment, not one appointments", () => {
    expect(render([BOOK_FAILED])).toContain(
      ">1</span> appointment needs attention",
    );
  });

  it("says why Callzie has stopped", () => {
    // The rule the whole surface exists to make visible (SPEC.md §5).
    expect(render([BOOK_FAILED])).toContain(
      "Callzie will not call these until you clear them",
    );
  });

  it("names the person and the specific problem", () => {
    const html = render([BOOK_FAILED]);

    expect(html).toContain("Priya Sharma");
    expect(html).toContain("Maya could not book the new time");
  });

  it("counts attempts in the unreachable row", () => {
    expect(render([UNREACHABLE])).toContain("Nobody answered after 2 attempts");
  });

  it("shows the Slot in the Business's timezone", () => {
    // 03:30 UTC is 09:00 in Kolkata. A time in the viewer's zone would be a
    // different appointment.
    expect(render([BOOK_FAILED])).toContain("09:00");
  });

  it("gives every row its own Clear action", () => {
    const html = render([BOOK_FAILED, UNREACHABLE]);

    expect(html.match(/>Clear</g)).toHaveLength(2);
  });

  it("names each Clear for a screen reader", () => {
    // Two identical buttons are two identical announcements without this — the
    // same call components/calls/call-now-button.tsx makes.
    const html = render([BOOK_FAILED, UNREACHABLE]);

    expect(html).toContain("— Priya Sharma");
    expect(html).toContain("— Daniel Okafor");
  });

  it("separates the row's fields for a screen reader", () => {
    /*
      The separators are `aria-hidden`, so nothing but real space characters
      keeps these three fields apart in the accessibility tree. Written without
      them the row reads "Priya SharmaFri 14 Aug, 09:00Cleaning" — JSX drops
      whitespace between elements on separate lines, and the dots' padding
      looks like a space without being one.
    */
    const text = render([BOOK_FAILED]).replace(/<[^>]+>/g, "");

    expect(text).toContain("Priya Sharma · Fri 14 Aug, 09:00 · Cleaning");
  });

  it("renders a Collision, which arrives with no Call behind it", () => {
    /*
      The row #20 will produce. It is detected from the connected calendar
      rather than from a Call, so `attempts` is 0 — the one row shape where
      nothing on this screen came from the phone at all.
    */
    const html = render([COLLISION]);

    expect(html).toContain("Ana Silva");
    expect(html).toContain("This clashes with an event");
    expect(html).toContain("decide which keeps the time");
  });

  it("is a labelled section rather than a live region", () => {
    /*
      Persistent UI, so no `role="alert"`. A live region would have a screen
      reader re-announce the whole list on every unrelated re-render of the page,
      of which there is one after every quick-add. Same call
      components/overview/call-alerts.tsx makes.
    */
    const html = render([BOOK_FAILED]);

    expect(html).toContain('aria-labelledby="needs-attention-heading"');
    expect(html).not.toContain('role="alert"');
  });
});
