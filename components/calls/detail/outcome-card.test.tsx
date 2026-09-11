import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { OutcomeCard } from "@/components/calls/detail/outcome-card"
import { callOutcome, type InvocationRow } from "@/lib/calls/outcome"

/*
  The card the whole screen exists for.

  Two acceptance criteria land here: "the Outcome card shows every Tool
  invocation in order, including failed ones", and "a Call where the Agent
  invoked nothing renders sensibly rather than blank".
*/

const AT = (seconds: number) => new Date(2026, 7, 21, 9, 0, seconds)

const CHECK: InvocationRow = {
  id: "check",
  toolName: "check_availability",
  arguments: {},
  result: {
    ok: true,
    slots: [
      {
        slot_start: "2026-08-27T10:30:00.000Z",
        time: "Thursday at four in the afternoon",
      },
    ],
  },
  succeeded: true,
  latencyMs: 120,
  createdAt: AT(1),
}

const FAILED_BOOK: InvocationRow = {
  id: "book",
  toolName: "book_slot",
  arguments: { slot_start: "2026-08-27T10:30:00.000Z" },
  result: { ok: false, reason: "slot_taken" },
  succeeded: false,
  latencyMs: 340,
  createdAt: AT(2),
}

/* The one line the card leads with. Its own wording is tested in outcome.test.ts. */
const VERDICT = "Booked, Thu 28 Aug, 10:30."

const NO_TOOLS = {
  headline: "Nothing was decided",
  detail: "Maya spoke to Priya, invoked no Tools.",
}

describe("OutcomeCard", () => {
  it("shows a failed invocation, marked as failed", () => {
    const html = renderToStaticMarkup(
      <OutcomeCard outcome={callOutcome([CHECK, FAILED_BOOK])} noTools={NO_TOOLS} verdict={VERDICT} />
    )

    expect(html).toContain("book_slot")
    expect(html).toContain("Failed")
    expect(html).toContain("slot_taken")
  })

  it("shows both invocations, in the order they ran", () => {
    const html = renderToStaticMarkup(
      <OutcomeCard outcome={callOutcome([CHECK, FAILED_BOOK])} noTools={NO_TOOLS} verdict={VERDICT} />
    )

    expect(html.indexOf("check_availability")).toBeLessThan(html.indexOf("book_slot"))
  })

  it("renders each invocation's latency in mono", () => {
    const html = renderToStaticMarkup(
      <OutcomeCard outcome={callOutcome([CHECK, FAILED_BOOK])} noTools={NO_TOOLS} verdict={VERDICT} />
    )

    expect(html).toContain("340")
    expect(html).toContain("font-mono")
  })

  it("lists the Slots the Call offered, in the words Maya said", () => {
    const html = renderToStaticMarkup(
      <OutcomeCard outcome={callOutcome([CHECK])} noTools={NO_TOOLS} verdict={VERDICT} />
    )

    expect(html).toContain("Thursday at four in the afternoon")
  })

  it("says nothing was booked when no booking committed", () => {
    const html = renderToStaticMarkup(
      <OutcomeCard outcome={callOutcome([CHECK, FAILED_BOOK])} noTools={NO_TOOLS} verdict={VERDICT} />
    )

    /*
      The verdict is passed in now and rendered as the card's first line, so
      this asserts the card shows what it was handed rather than re-deriving
      the sentence. `lib/calls/outcome.test.ts` is where the wording is tested.
    */
    expect(html).toContain(VERDICT)
  })

  it("names the booked time when one committed", () => {
    const booked: InvocationRow = {
      ...FAILED_BOOK,
      succeeded: true,
      result: { ok: true, booked_time: "Thursday at four in the afternoon" },
    }

    const html = renderToStaticMarkup(
      <OutcomeCard outcome={callOutcome([CHECK, booked])} noTools={NO_TOOLS} verdict={VERDICT} />
    )

    expect(html).toContain("Booked")
  })

  it("renders the no-Tools sentence, not a blank card, when nothing ran", () => {
    const html = renderToStaticMarkup(
      <OutcomeCard outcome={callOutcome([])} noTools={NO_TOOLS} verdict={VERDICT} />
    )

    expect(html).toContain("Nothing was decided")
    expect(html).toContain("Maya spoke to Priya, invoked no Tools.")
  })
})
