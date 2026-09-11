import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { FailureCard } from "@/components/calls/detail/failure-card"

/*
  "Failed and no-answer Calls show the reason and offer Retry" — #16's fifth
  acceptance criterion, minus the one case where Retry cannot possibly work.

  The Retry button is a client component that reads the live-call context, and a
  context read outside a provider throws. `FailureCard` therefore takes the
  button as a prop rather than importing it, which is also what lets this test
  render the card as a plain string.
*/

const RETRY = <button>Retry call</button>

describe("FailureCard", () => {
  it("gives an unanswered Call its reason", () => {
    const html = renderToStaticMarkup(
      <FailureCard disconnectReason="dial_no_answer" retry={RETRY} />
    )

    expect(html).toContain("Nobody answered")
    expect(html).toContain("Retry call")
  })

  it("renders amber, because this is something a person must act on", () => {
    const html = renderToStaticMarkup(
      <FailureCard disconnectReason="dial_no_answer" retry={RETRY} />
    )

    // The shared Card at tone="attention": the only coloured border in the app.
    expect(html).toContain("border-attention")
  })

  it("distinguishes voicemail from an unanswered phone", () => {
    const html = renderToStaticMarkup(
      <FailureCard disconnectReason="voicemail_reached" retry={RETRY} />
    )

    expect(html).toContain("Voicemail picked up")
  })

  it("does not render Retry when the Retell balance is gone", () => {
    const html = renderToStaticMarkup(
      <FailureCard disconnectReason="no_valid_payment" retry={RETRY} />
    )

    // No vendor names in anything an owner reads.
    expect(html).toContain("The calling account is out of credit")
    expect(html).not.toContain("Retry call")
  })

  it("still shows something for a Call that recorded no reason", () => {
    const html = renderToStaticMarkup(
      <FailureCard disconnectReason={null} retry={RETRY} />
    )

    expect(html).toContain("The call failed")
    expect(html).toContain("Retry call")
  })
})
