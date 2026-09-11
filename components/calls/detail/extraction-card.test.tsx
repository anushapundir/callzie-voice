import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { ExtractionCard } from "@/components/calls/detail/extraction-card"
import type { CallExtraction } from "@/lib/calls/detail"

/*
  "A failed extraction renders as a designed amber card with the raw output" —
  #16's fourth acceptance criterion, and SPEC.md §11.3's "never an unstyled
  error".

  The sentence that has to survive on that card is the one about the Tools: a
  failed extraction changes nothing about what the Agent recorded during the
  Call (SPEC.md §9 step 3). Somebody reading an amber card needs to know the
  booking is still good.
*/

const OK: CallExtraction = {
  notes: "Wants an evening slot next time.",
  summary: "Rebooked to Thursday afternoon.",
  sentiment: "positive",
  inVoicemail: false,
  confirmed: null,
  newTime: null,
  status: "ok",
  rawLlmOutput: null,
}

describe("ExtractionCard", () => {
  it("shows notes, summary and sentiment", () => {
    const html = renderToStaticMarkup(<ExtractionCard extraction={OK} />)

    expect(html).toContain("Wants an evening slot next time.")
    expect(html).toContain("Rebooked to Thursday afternoon.")
    expect(html).toContain("Positive")
  })

  it("puts the raw JSON in a collapsed block", () => {
    const html = renderToStaticMarkup(<ExtractionCard extraction={OK} />)

    expect(html).toContain("<details")
    expect(html).not.toContain("<details open")
    expect(html).toContain("Raw JSON")
  })

  it("renders amber, with the raw output, when the extraction failed", () => {
    const html = renderToStaticMarkup(
      <ExtractionCard
        extraction={{
          ...OK,
          status: "failed",
          notes: null,
          summary: null,
          sentiment: null,
          rawLlmOutput: "Sure! Here is the JSON you asked for: {oops",
        }}
      />
    )

    expect(html).toContain("border-attention")
    expect(html).toContain("The write-up failed")
    expect(html).toContain("Sure! Here is the JSON you asked for: {oops")
  })

  it("says the Call's recorded outcome is unaffected by a failed extraction", () => {
    const html = renderToStaticMarkup(
      <ExtractionCard
        extraction={{ ...OK, status: "failed", rawLlmOutput: "{oops" }}
      />
    )

    expect(html).toContain("unaffected")
  })

  it("handles a failed extraction that stored no raw output at all", () => {
    const html = renderToStaticMarkup(
      <ExtractionCard extraction={{ ...OK, status: "failed", rawLlmOutput: null }} />
    )

    expect(html).toContain("The write-up failed")
    expect(html).toContain("nothing was stored")
  })

  it("renders a waiting panel when the extraction has not run yet", () => {
    const html = renderToStaticMarkup(<ExtractionCard extraction={null} />)

    expect(html).toContain("Nothing written up yet")
  })

  it("says so plainly when a field came back empty", () => {
    const html = renderToStaticMarkup(
      <ExtractionCard extraction={{ ...OK, notes: null }} />
    )

    // One em dash for every empty field, instead of three different negatives.
    expect(html).toContain("—")
  })
})
