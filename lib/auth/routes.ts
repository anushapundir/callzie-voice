/**
 * The gate routes — the screens a visitor is sent to when they are not yet
 * allowed to be where they asked for.
 *
 * They are referenced from layers that cannot see each other — the proxy
 * (`proxy.ts`), the client provider (`app/layout.tsx`) and the server-side
 * guards (`lib/auth/require-user.ts`, `lib/business/require-business.ts`) — and
 * a typo in any one of them fails the same silent way: for the auth routes, the
 * visitor lands on Clerk's hosted Account Portal on `*.accounts.dev` instead of
 * the themed screen in `app/(auth)`; for onboarding, the redirect 404s.
 *
 * They are constants rather than `NEXT_PUBLIC_CLERK_SIGN_IN_URL` env vars for
 * the same reason: these are routes in this repo, not deployment config, and an
 * env var left unset in one environment reverts to the Account Portal without
 * saying so. `lib/nav.ts` holds the app's other routes on the same principle.
 */
export const SIGN_IN_URL = "/sign-in";
export const SIGN_UP_URL = "/sign-up";

/**
 * Where an account with no Business is sent (SPEC.md §11.3, ADR-0006).
 *
 * Deliberately absent from `lib/nav.ts`: it is a gate, not a destination, and
 * it must never appear in the sidebar.
 */
export const ONBOARDING_URL = "/onboarding";
