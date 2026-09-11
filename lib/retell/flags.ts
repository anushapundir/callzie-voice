/*
  Command-line flags for scripts/create-agent.ts.

  These live in lib/ rather than next to the script for one reason: the script
  calls main() at module scope, so importing it from a test provisions Agents.
  This file is pure, and the behaviour below is worth a regression test because
  getting it wrong is silent and expensive.

  The problem it solves: flags do not survive `npm run`. npm 11 pulls every
  `--flag` out of the arguments after `--`, converts it to an
  `npm_config_<flag_with_underscores>` environment variable, and hands the script
  an empty argv — warning only for names it does not already recognise. So

      npm run create-agents -- --dry-run

  performed a full provisioning run against live Retell: the flag was gone before
  the script started, and the default path is "do the thing". A flag whose entire
  promise is "changes nothing" that instead changes everything, without an error,
  is the worst failure mode available, so every flag is read from both sources
  rather than documenting an incantation nobody will remember.

  Direct invocation (`npx tsx scripts/create-agent.ts --dry-run`) passes argv
  normally and is unaffected either way.

  Known caveat: an `.npmrc` setting one of these names would switch the matching
  mode on here too, and `offline` is a real npm config. Every flag is fail-safe —
  each one makes the script do less, never more — so the worst case is a
  confusing no-op rather than an unwanted write.
*/

/**
 * The environment the flags are read from. Deliberately not NodeJS.ProcessEnv:
 * Next widens that type to require NODE_ENV, which would force every test to
 * supply an irrelevant value.
 */
type Env = Record<string, string | undefined>;

/** `--list-voices` -> `npm_config_list_voices`. */
function npmConfigName(flag: string): string {
  return `npm_config_${flag.replace(/^--/, "").replace(/-/g, "_")}`;
}

/**
 * True when a boolean flag was passed, whether or not npm ate it.
 *
 * npm renders a consumed boolean flag as the string "true"; `--no-foo` becomes
 * "false", which must not read as set.
 */
export function flagSet(
  argv: string[],
  flag: string,
  env: Env = process.env,
): boolean {
  return argv.includes(flag) || env[npmConfigName(flag)] === "true";
}

/**
 * The value of a `--flag value` pair, or null.
 *
 * argv wins over the environment so that a direct invocation is never
 * second-guessed by a stale npm config. A flag passed with no value after it
 * yields null rather than swallowing the next flag.
 */
export function flagValue(
  argv: string[],
  flag: string,
  env: Env = process.env,
): string | null {
  if (argv.includes(flag)) {
    const next = argv[argv.indexOf(flag) + 1];
    return next === undefined || next.startsWith("--") ? null : next;
  }

  return env[npmConfigName(flag)] ?? null;
}
