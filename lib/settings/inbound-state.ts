/*
  What the two inbound Server Actions hand back to `useActionState` (issue #43).

  **A separate module from `lib/settings/inbound.ts`, and the separation is
  load-bearing rather than tidy.** That file talks to Postgres, so it imports
  `@/lib/db` and therefore `pg`. `components/settings/inbound-section.tsx` is a
  client component and needs this constant for its initial state — importing it
  from there pulls `pg` into the browser bundle, and the build fails with a
  module-not-found on `dns`, `fs` and `net`.

  This is why every `*-input.ts` in this directory is pure and keeps its own
  `INITIAL_*` constant. The rule is not "state types live in lib/"; it is "the
  things a client component imports must not reach the database".
*/

/**
 * One optional field, because there is only ever one thing to say: either the
 * write landed, or it did not and here is why.
 */
export type InboundActionState = { error?: string };

export const INITIAL_INBOUND_STATE: InboundActionState = {};
