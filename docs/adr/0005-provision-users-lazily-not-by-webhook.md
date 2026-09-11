# ADR-0005: Provision the `users` row lazily, not from a Clerk webhook

**Status:** Accepted
**Date:** 2026-08-11
**Relates to:** SPEC.md §5 (`users`), §14 rule 9 (one Business, one login)

## Context

Clerk owns identity; Postgres owns everything the product knows about a person.
Something has to create the `users` row that joins them, and there are two
standard ways to do it:

1. **Webhook.** Clerk POSTs `user.created` to an endpoint here, which inserts
   the row.
2. **Lazily.** The first authenticated request an account makes creates its own
   row on the way through.

## Decision

Provision lazily, in `lib/auth/require-user.ts`, called from the app shell
layout that wraps every signed-in route.

## Rationale

The webhook route buys nothing this product needs and costs three things it
would rather not carry:

- **A fourth secret and a fourth failure mode.** `CLERK_WEBHOOK_SECRET` joins
  the Retell one in `.env.example`, and a missed or late delivery leaves a
  signed-in person with no row — a state every downstream query would have to
  defend against anyway. Lazy provisioning collapses that: the row is created by
  the code path that reads it, so anything that goes through `requireUser()` is
  guaranteed one. Note the guarantee is scoped to callers of `requireUser()`,
  not to "anyone with a session" — an authenticated route handler that never
  calls it can still see a `userId` with no row behind it, and must call it.
- **A race Clerk does not resolve.** The webhook is asynchronous. A fast signup
  can land on `/` before the delivery arrives, so the lazy path has to exist
  regardless. Building both means maintaining both.
- **Local development.** Webhooks need a public tunnel to reach a laptop.
  Nothing else in the M0 loop does.

The one thing a webhook is genuinely better at — reacting to `user.deleted` —
is out of scope: SPEC.md has no account-deletion flow.

The correctness requirement this puts on the lazy path is idempotency under
concurrency: two tabs opened at once must not produce two rows or a 500 from
the `clerk_id` unique index. `provisionUser` is therefore a single
`INSERT … ON CONFLICT (clerk_id) DO UPDATE … RETURNING` rather than a
select-then-insert, and `lib/auth/provision-user.test.ts` races it against
itself to prove it. `DO UPDATE` rather than `DO NOTHING` only because the
latter returns no row on conflict, leaving the losing caller with nothing to
hand back.

## Consequences

- Every signed-in page render costs one indexed lookup on `users.clerk_id`. The
  upsert and the call out to Clerk for an email happen only on the miss, which
  is once per account.
- The User row is created on first **sign-in**, not at signup. An account that
  is created and abandoned before reaching the app leaves nothing in Postgres —
  which is the desired reading of "a `users` row is created on first sign-in".
- **The email is a snapshot taken at provisioning time.** `requireUser()`
  returns early once the row exists, so nothing re-reads Clerk afterwards and a
  changed email goes stale. Keeping it fresh is a webhook's job and is deferred
  with the rest of the webhook decision. Nothing in SPEC.md reads this column
  yet; the day something does, that is the trigger below.
- **The call site is the app shell layout, which Next explicitly cautions
  against** — layouts skip re-rendering on client-side navigation, and a
  top-level `await` there holds `{children}` behind it
  (`node_modules/next/dist/docs/01-app/02-guides/authentication.md`,
  "Layouts and auth checks"). Accepted, because neither caveat bites here: the
  security gate is `proxy.ts`, not this call, so a skipped re-render cannot let
  anyone in; and the awaited work is a single indexed lookup. Revisit when the
  shell starts rendering from the row (the Quota meter, at M2) — at that point
  the `await` should move into the component that consumes it, wrapped in
  `<Suspense>`, per the same doc's "Auth and streaming".

## Revisit if

- Account deletion enters scope, or anything starts reading `users.email` — or
  anything else needs to react to a Clerk-side change without the person
  signing in again. That is the point where the webhook earns its secret.
