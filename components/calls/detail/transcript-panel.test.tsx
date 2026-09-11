import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { RecordingPlayer } from "@/components/calls/detail/recording-player"
import { TranscriptPanel } from "@/components/calls/detail/transcript-panel"
import type { TranscriptTurn } from "@/lib/calls/transcript"

/*
  What the left column actually puts on the page.

  `lib/calls/transcript.test.ts` pins the parsing; this pins the markup, because
  two of #16's acceptance criteria are about what renders — "the transcript
  renders as a readable two-sided conversation, with mono timestamps", and "the
  screen still works when the recording url has not arrived yet".

  `renderToStaticMarkup` rather than a testing library: these are synchronous
  components with no effects to run, so a string of HTML is the whole output.
  Same approach, and the same reasoning, as
  components/schedule/day-grid.test.tsx.
*/

const TURNS: TranscriptTurn[] = [
  { speaker: "agent", text: "Hi Priya, this is Maya.", startSeconds: 0.4 },
  { speaker: "person", text: "Hello.", startSeconds: 12 },
]

describe("TranscriptPanel", () => {
  it("renders both sides of the conversation", () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel turns={TURNS} personName="Priya" />
    )

    expect(html).toContain("Hi Priya, this is Maya.")
    expect(html).toContain("Hello.")
  })

  it("names each speaker rather than relying on which side it sits on", () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel turns={TURNS} personName="Priya" />
    )

    expect(html).toContain("Maya")
    expect(html).toContain("Priya")
  })

  it("washes the person's turns so the two speakers are told apart", () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel turns={TURNS} personName="Priya" />
    )

    /*
      A script, not a chat. The customer's lines used to be right-aligned
      bubbles, which made a transcript hard to read straight down and put the
      shorter turns in a ragged column. Now every turn starts at the same
      margin and the customer's row carries a wash instead.
    */
    expect(html).toContain("bg-surface-soft")
    expect(html).not.toContain("justify-end")
  })

  it("renders timestamps in mono", () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel turns={TURNS} personName="Priya" />
    )

    expect(html).toContain("00:00")
    expect(html).toContain("00:12")
    expect(html).toContain("font-mono")
  })

  it("omits the stamp entirely on an unstamped turn rather than showing a placeholder", () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel
        turns={[{ speaker: "agent", text: "Hello.", startSeconds: null }]}
        personName="Priya"
      />
    )

    expect(html).not.toContain("—")
    expect(html).toContain("Hello.")
  })

  it("renders a waiting panel, not nothing, when there is no transcript yet", () => {
    const html = renderToStaticMarkup(
      <TranscriptPanel turns={[]} personName="Priya" />
    )

    expect(html).toContain("Transcript not ready yet")
  })
})

describe("RecordingPlayer", () => {
  it("renders an audio element when the url has arrived", () => {
    const html = renderToStaticMarkup(
      <RecordingPlayer recordingUrl="https://example.com/a.wav" durationSeconds={95} />
    )

    expect(html).toContain("<audio")
    expect(html).toContain("https://example.com/a.wav")
  })

  it("shows the total duration in mono", () => {
    const html = renderToStaticMarkup(
      <RecordingPlayer recordingUrl="https://example.com/a.wav" durationSeconds={95} />
    )

    expect(html).toContain("01:35")
    expect(html).toContain("font-mono")
  })

  it("renders a waiting panel and no audio element when the url has not arrived", () => {
    const html = renderToStaticMarkup(
      <RecordingPlayer recordingUrl={null} durationSeconds={95} />
    )

    expect(html).not.toContain("<audio")
    expect(html).toContain("Recording not ready yet")
  })
})
