import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { BatchStripView } from "@/components/overview/batch-strip-view"

/*
  The persistent inline UI a running batch gets (SPEC.md §11.4 — inline, never
  a toast, for anything a person may need to act on).
*/

describe("BatchStripView", () => {
  it("renders nothing when no batch is running", () => {
    const html = renderToStaticMarkup(
      <BatchStripView calling={0} waiting={0} onStop={() => {}} stopping={false} />
    )

    expect(html).toBe("")
  })

  it("says what is happening and what is waiting", () => {
    const html = renderToStaticMarkup(
      <BatchStripView calling={2} waiting={4} onStop={() => {}} stopping={false} />
    )

    expect(html).toContain("Calling 2")
    expect(html).toContain("4 waiting")
    expect(html).toContain("Stop")
  })

  it("hides Stop once nothing is waiting, because it would do nothing", () => {
    const html = renderToStaticMarkup(
      <BatchStripView calling={1} waiting={0} onStop={() => {}} stopping={false} />
    )

    expect(html).toContain("Calling 1")
    expect(html).not.toContain("Stop")
  })
})
