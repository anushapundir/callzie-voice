/*
  What the widget Server Actions hand back to `useActionState` (issue #45).

  A separate module from `lib/settings/widget.ts` for the reason
  `lib/settings/inbound-state.ts` spells out: that file talks to Postgres, and a
  client component importing from it pulls `pg` into the browser bundle. The
  build fails on `dns` and `net`, which is a confusing way to learn this.
*/

export type WidgetState = {
  error?: string;
  /** The key, after a successful save. Null when the widget was switched off. */
  key?: string | null;
  saved?: boolean;
};

export const INITIAL_WIDGET_STATE: WidgetState = {};
