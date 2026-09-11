import { describe, expect, it } from "vitest"

import { businessQuota, quotaPercentUsed } from "@/lib/quota"

describe("businessQuota", () => {
  it("passes a normal account's Quota through", () => {
    expect(
      businessQuota({ callsUsed: 0, callQuota: 5, isAdmin: false }),
    ).toEqual({ callsUsed: 0, callQuota: 5 })
  })

  it("renders an admin account as unlimited", () => {
    // The row still carries a NOT NULL call_quota; `is_admin` is what decides.
    expect(
      businessQuota({ callsUsed: 12, callQuota: 5, isAdmin: true }),
    ).toEqual({ callsUsed: 12, callQuota: null })
  })

  it("leaves an unlimited meter empty rather than overfull", () => {
    const quota = businessQuota({ callsUsed: 99, callQuota: 5, isAdmin: true })
    expect(quotaPercentUsed(quota)).toBe(0)
  })
})
