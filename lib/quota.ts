/**
 * The number of Calls an account is permitted to place, and how many it has
 * used. CONTEXT.md names this concept **Quota** and rules out "credits",
 * "limit", "allowance" and "balance" — so the fields carry SPEC.md §5's column
 * names rather than any of those synonyms.
 *
 * `callQuota: null` means an admin account, which displays as "Unlimited".
 */
export type Quota = {
  callsUsed: number
  callQuota: number | null
}

/**
 * How full the meter reads, 0–100. An account with a zero Quota is fully
 * consumed by definition — never NaN.
 */
export function quotaPercentUsed({ callsUsed, callQuota }: Quota): number {
  if (callQuota === null) return 0
  if (callQuota <= 0) return 100
  return Math.min(100, Math.round((callsUsed / callQuota) * 100))
}

/**
 * A Business row's Quota, as the meter wants it.
 *
 * The two sides spell "unlimited" differently and this is the only place they
 * meet: `businesses` models an admin as `is_admin boolean` with a NOT NULL
 * `call_quota`, while `Quota` models it as `callQuota: null` because that is
 * what SPEC.md §11.1 renders as "Unlimited". Translating at the boundary keeps
 * the meter from having to know about admin at all.
 *
 * Structurally typed rather than taking the row, so it is testable without
 * Postgres.
 */
export function businessQuota(business: {
  callsUsed: number
  callQuota: number
  isAdmin: boolean
}): Quota {
  return {
    callsUsed: business.callsUsed,
    callQuota: business.isAdmin ? null : business.callQuota,
  }
}
