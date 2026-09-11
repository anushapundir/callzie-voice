/**
 * Which environment variables this deployment has — as booleans, and nothing
 * else.
 *
 * Settings shows a configuration panel (issue #5) so that "the calls stopped
 * going out" can resolve to "ANTHROPIC_API_KEY is blank on the deployed
 * service" without shelling into a container. SPEC.md §3 rule 1 puts every
 * secret in the environment, which makes a missing one both the likeliest cause
 * of a dead feature and the least visible from inside the product.
 *
 * The panel is admin-gated at the UI layer (`businesses.is_admin`, SPEC.md §5).
 * This function is the second line of that defence, because Callzie is **open
 * signup** (SPEC.md §14 rule 9): anybody can hold an account, so everything the
 * panel renders is reconnaissance for an attacker who already has one. Hence
 * booleans only — never a value, never a prefix, never a length, never a masked
 * rendering of any of the three. A length distinguishes a test key from a live
 * one; a prefix names the provider account. The guarantee worth having is that
 * a gate bypassed once still leaks nothing, and the only way to hold it is for
 * the secret never to enter the return value at all.
 */

/** The sections the panel groups by, in `.env.example`'s order. */
export type EnvGroup =
  | "Database"
  | "Retell"
  | "Anthropic"
  | "Clerk"
  | "Google"
  | "Internal"
  | "App";

export type EnvVarStatus = {
  name: string;
  group: EnvGroup;
  /** False means Callzie is expected to run fully without it. */
  required: boolean;
  /** Present and not blank. Deliberately says nothing about the value. */
  set: boolean;
};

/**
 * The outbound caller ID, named once.
 *
 * Exported because the Phone Call switch on Settings looks this row up by name
 * to warn that the flag will not help without it. A bare `"RETELL_FROM_NUMBER"`
 * string over there would survive a rename here and silently start matching
 * nothing — `find` would return `undefined`, the fallback would read as "not
 * set", and the switch would show a warning that is permanently wrong. Through
 * the constant, a rename is a compile error at both ends.
 *
 * It is the only catalogue entry any other module asks about by name, so it is
 * the only one with a constant. Twelve of these would be noise.
 */
export const RETELL_FROM_NUMBER = "RETELL_FROM_NUMBER";

/**
 * The environment as this module wants it. Deliberately not `NodeJS.ProcessEnv`
 * — Next widens that type to require `NODE_ENV`, which would force every test
 * to supply a value irrelevant to what is being asserted.
 */
type Env = Record<string, string | undefined>;

/*
  The catalogue, kept in `.env.example`'s order so that a variable added to one
  file and forgotten in the other shows up as a diff between two short lists.

  GCP_PROJECT_ID, GCP_REGION and CLOUDSQL_CONNECTION_NAME are deliberately
  absent: no code the server runs reads them. They are inputs to
  scripts/setup-infrastructure.sh and to the deploy, and the deployed service
  legitimately does not carry them — listing them would put permanently red rows
  on the panel and teach whoever reads it that red rows mean nothing.
*/
const CATALOGUE: readonly Omit<EnvVarStatus, "set">[] = Object.freeze([
  { name: "DATABASE_URL", group: "Database", required: true },

  { name: "RETELL_API_KEY", group: "Retell", required: true },
  /*
    Optional: Phone Calls ship behind a flag (SPEC.md §3 rule 9) and the Web
    Call path — the default — never dials from a number. Requiring it would
    mark a correctly configured demo account as broken, since the number cannot
    be bought until Retell KYC clears.
  */
  { name: RETELL_FROM_NUMBER, group: "Retell", required: false },
  { name: "RETELL_WEBHOOK_SECRET", group: "Retell", required: true },

  { name: "ANTHROPIC_API_KEY", group: "Anthropic", required: true },

  {
    name: "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    group: "Clerk",
    required: true,
  },
  { name: "CLERK_SECRET_KEY", group: "Clerk", required: true },

  /*
    Every Google variable is optional, and that is a design commitment rather
    than laxity: ADR-0004 requires Callzie to be fully functional for a Business
    that never connects Google, and ships the integration with the OAuth app in
    Testing status. An unset Google row is a normal deployment, not a fault.
  */
  { name: "GOOGLE_CLIENT_ID", group: "Google", required: false },
  { name: "GOOGLE_CLIENT_SECRET", group: "Google", required: false },
  /* Encrypts `businesses.google_refresh_token` at rest — ADR-0009. */
  { name: "TOKEN_ENCRYPTION_KEY", group: "Google", required: false },

  { name: "INTERNAL_SECRET", group: "Internal", required: true },

  { name: "APP_URL", group: "App", required: true },
]);

/**
 * Whether a variable counts as configured.
 *
 * Blank and whitespace-only both read as **not set**. An empty assignment in
 * `.env.local` — `ANTHROPIC_API_KEY=`, which is exactly what copying
 * `.env.example` leaves behind — is the most common way to believe something is
 * configured when it is not, and it is the one case a naive `name in env` check
 * gets wrong. A trailing space after a pasted key is the same failure with a
 * different cause, so trim before deciding.
 */
function isSet(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

/**
 * The configuration panel's rows.
 *
 * Takes the environment as an argument so tests can describe a deployment
 * without mutating `process.env`, which is global, shared across a Vitest file,
 * and restored incorrectly often enough to be worth designing away.
 *
 * The lookup is a dynamic index, which also means Next's build-time inlining of
 * `NEXT_PUBLIC_*` does not apply here — `process.env.NEXT_PUBLIC_…` written
 * literally would be substituted at build. That is fine, and in fact required:
 * this must report what the *running* service has, and the deploy passes that
 * key as a runtime env var as well as a build arg.
 */
export function envStatus(env: Env = process.env): EnvVarStatus[] {
  return CATALOGUE.map((variable) => ({
    ...variable,
    set: isSet(env[variable.name]),
  }));
}
