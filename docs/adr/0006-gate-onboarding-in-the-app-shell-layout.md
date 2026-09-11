# ADR-0006: Gate onboarding in the app shell layout, not in the proxy

**Status:** Accepted
**Date:** 2026-08-12
**Relates to:** SPEC.md §11.3, ADR-0005, issue #4

## Context

An account can be signed in and still have nothing: `users` is provisioned on the
first authenticated request (ADR-0005), but `businesses` is not written until the
person has picked a Business Type, named the Business and chosen a timezone.
Issue #4 requires that such an account is "routed to onboarding from anywhere in
the app".

Something therefore has to ask "does this account have a Business yet?" on every
signed-in request, and send it to `/onboarding` when the answer is no.

## Decision

`app/(app)/layout.tsx` calls `requireBusiness()` as a blocking top-level `await`.

`/onboarding` lives in its own `(onboarding)` route group with a bare layout,
outside the app shell, and carries the exact inverse guard: it redirects to `/`
when a Business already exists.

`currentBusiness()` — the read both guards share — is wrapped in React `cache()`.

## Rationale

**Not in `proxy.ts`.** That file is the security gate and deliberately touches no
database; it decides public-versus-private from the URL alone. Putting a `pg`
query behind every matched request would make the security boundary depend on
Postgres being up, and would couple "is this person allowed in" to "has this
person finished setup" — two questions with different failure modes. The layout
gate is product routing, and nothing about it is load-bearing for security.

**Not per-page.** A guard in each page is a guard someone forgets. The layout
wraps every route under `(app)`, so a screen added later is gated by
construction — the same "protected by omission" property `proxy.ts` argues for
with its public-route list.

**Not an interstitial inside the shell.** SPEC.md §11.3 asks for one screen, and
rendering onboarding inside the shell would show a sidebar whose four
destinations all need a Business, plus a Quota meter with no row to read.

**Loop avoidance is structural.** The two guards are exact inverses on disjoint
route trees: `(app)` requires a Business, `(onboarding)` requires its absence.
`/onboarding` never renders through the app shell layout, so it can never reach
`requireBusiness()`. There is deliberately no `if (pathname === "/onboarding")`
escape hatch anywhere — that kind of conditional is what silently breaks when a
route moves.

## This supersedes ADR-0005's revisit instruction

ADR-0005 accepted calling `requireUser()` from the shell layout, noting Next's
caution about auth checks in layouts, and said:

> Revisit when the shell starts rendering from the row (the Quota meter, at M2)
> — at that point the `await` should move into the component that consumes it,
> wrapped in `<Suspense>`.

That moment is this ticket, and the answer is **no**. The premise changed:

1. **A redirect cannot be streamed.** `requireBusiness()` may `redirect()`. If
   the shell has already flushed, that degrades into a client-side hop, and an
   un-onboarded account sees a sidebar, a Quota meter and an empty Overview
   before being thrown to `/onboarding`. That is precisely the blank first
   impression issue #4 exists to prevent. The `await` has to block.
2. **`cache()` removes the cost the Suspense advice was buying back.** The
   guidance exists so awaited work is not on the critical path more than once.
   With `currentBusiness` cached per request, the layout, the Overview page and
   the Quota meter share one indexed lookup; suspending the meter would suspend
   on data that is already resolved.
3. **The layouts-skip-re-render caveat still does not bite,** for ADR-0005's own
   reason: `proxy.ts` remains the security gate, so a skipped re-render cannot
   let anyone in. The only way to reach `(app)` without a Business is a fresh
   request, which re-renders the layout.

## Consequences

- Every signed-in page render costs two indexed lookups — `users.clerk_id` and
  `businesses.user_id` — and no more, however many components read the Business.
- The Quota meter now renders from the row (`businessQuota()` in `lib/quota.ts`),
  which is where the schema's `is_admin boolean` is translated into the meter's
  `callQuota: null`. Only `ACTIVE_CALLS` in the shell is still a constant; it
  waits on #11.
- The gate is UX routing, not security. Anything that must be secure belongs in
  `proxy.ts`.
- **A route that must be reachable without a Business has to live outside
  `(app)`.** Nothing needs that today. A billing-expired screen, an
  account-deleted screen or a support page would — that is the revisit trigger.

## Revisit if

- A screen needs to render inside the app shell for an account with no Business.
- The Business read stops being a single indexed lookup — a join, or a
  cross-service call — at which point the streaming question is worth reopening
  for the parts of the shell that are not the redirect.
