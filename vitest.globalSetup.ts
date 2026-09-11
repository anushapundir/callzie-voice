import { rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import EmbeddedPostgres from "embedded-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";

/*
  A real Postgres, on this machine, for the whole test run.

  The suite used to talk to Cloud SQL through the Auth Proxy. Three problems with
  that, and this file fixes all three:

    1. Issue #6 requires the suite to run with no network access.
    2. Every query was a round trip to us-central1, which is why the timeouts in
       vitest.config.mts had to be raised to 30s.
    3. It was the same database that backs the live Cloud Run URL. The test in
       lib/availability/book.test.ts DROPS the no-overlap constraint to prove the
       test is sensitive to it — doing that to production would open a window
       where Callzie really can double-book.

  Postgres 16 to match production's --database-version=POSTGRES_16
  (scripts/setup-infrastructure.sh:353), and btree_gist is present in these
  binaries, which is what makes drizzle/0001's EXCLUDE constraint loadable. An
  EXCLUDE constraint is a database rule that refuses a row when it conflicts with
  a row already there.

  The `embedded-postgres` version in package.json ends in `-beta.17`, which looks
  alarming and is not. That package only ships prebuilt Postgres binaries, and
  `-beta.N` is the upstream project's ordinary release channel for its 16 line —
  there is no non-beta 16 to move to. It is pinned exactly for that reason.
*/

/*
  These four are deliberately not configurable. A test harness you can point at
  a real database is one that will eventually be pointed at one, and these
  constants are what stop that.

  Changing USER or PASSWORD makes an existing .pgdata unusable — initdb baked the
  old ones in — so delete that directory after editing either.
*/
const DATA_DIR = fromHere(".pgdata");
const MIGRATIONS_DIR = fromHere("drizzle");
const USER = "postgres";
const PASSWORD = "postgres";
const DATABASE = "callzie_test";

/*
  NOT 5432. scripts/setup-infrastructure.sh tells the developer to run the Cloud
  SQL Auth Proxy on 5432, and a collision there would be baffling to debug.

  The port is the one value the machine decides rather than the test, which is
  why it is the only one you can override. This repo is normally checked out as
  several git worktrees at once. DATA_DIR is resolved per worktree so each gets
  its own cluster, but they would all reach for one port, and on Windows that is
  worse than a clean failure: two servers are both allowed to bind 127.0.0.1 on
  the same port, and connections then go to whichever one Windows picks. A test
  could quietly read the other worktree's database. Set CALLZIE_TEST_PG_PORT to
  run two suites side by side.
*/
const PORT = Number(process.env.CALLZIE_TEST_PG_PORT) || 55_432;

const url = (database: string) =>
  `postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${database}`;

let postgres: EmbeddedPostgres | undefined;

export async function setup() {
  postgres = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: USER,
    password: PASSWORD,
    port: PORT,
    // Keep the cluster between runs. `initialise` below is the slow part.
    persistent: true,
    /*
      Postgres prints a lot, and by default `onLog` goes to console.log and
      `onError` to console.error — every server line lands in the test output and
      buries the actual failures. So collect them instead of printing them, and
      the error paths below attach the tail to whatever they throw. Quiet on a
      green run, specific on a red one.
    */
    onLog: remember,
    onError: remember,
  });

  /*
    `initialise` runs initdb, the command that builds a Postgres data directory
    from scratch. It takes several seconds and it refuses to run against a
    directory that already holds a cluster. So do it only once and keep the
    result — paying it on every `npm test` would undo the speed this file exists
    to buy.

    `PG_VERSION` is the marker. Every Postgres data directory has that file, so
    if it is missing there is no cluster here yet and we build one. The `rm`
    first clears anything a run that died during initdb left behind, because
    initdb will not write into a directory that is not empty.

    Asking about the file, rather than trying to start and treating a failure as
    "nothing here", is deliberate. `start` also fails when something else is
    already listening on the port, and deleting the data directory in that case
    would pull it out from under a Postgres that is still running.
  */
  try {
    if (!(await hasCluster())) {
      await rm(DATA_DIR, { recursive: true, force: true });
      await postgres.initialise();
    }
    await postgres.start();
  } catch (cause) {
    /*
      Two reasons this needs wrapping. `start` rejects with no reason at all when
      the server process exits, which reads as a blank failure in the test
      output. And the reasons it does report — running as root, or no prebuilt
      binary for this platform — are nothing to do with the data directory, so
      they must not be replaced with advice about it.

      Postgres itself explains the common cases ("Address already in use", "data
      directory was initialized by PostgreSQL version ...") and `explain` puts
      that in the message.
    */
    throw explain(
      `Could not start the local test Postgres in ${DATA_DIR} on port ${PORT}. ` +
        "If the port is taken, another worktree's suite may be running — set " +
        "CALLZIE_TEST_PG_PORT to a free port. If the cluster is damaged, delete " +
        "that directory and run again.",
      cause,
    );
  }

  /*
    The cluster survives between runs but the DATABASE does not, and that is a
    correctness requirement rather than tidiness.

    book.test.ts drops `appointments_no_overlap` to prove its concurrency test
    is sensitive to it. If a run dies between the drop and the restore, a reused
    database would still have migration 0001 recorded as applied — so the
    constraint would never come back, and every later run would pass while
    testing a database with no no-overlap guarantee at all.

    "Every run" means every Vitest process, which is what `npm test` (`vitest
    run`) starts. Watch mode is the exception: `npx vitest` sets up once and then
    re-runs inside the same process, so a database damaged mid-run stays damaged
    until you restart it. Worth knowing before debugging book.test.ts in watch
    mode.

    Postgres will not drop a database you are connected to, so this is issued
    against the default `postgres` database.
  */
  try {
    await withClient("postgres", async (admin) => {
      await admin.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
      await admin.query(`CREATE DATABASE ${DATABASE}`);
    });
  } catch (cause) {
    throw explain(
      `Could not recreate the ${DATABASE} database. If this is a password ` +
        `failure, USER or PASSWORD changed since ${DATA_DIR} was built — delete ` +
        "that directory and run again.",
      cause,
    );
  }

  /*
    Migrate rather than push a schema snapshot. Migration 0001 is hand-written
    (Drizzle cannot express EXCLUDE) and is deliberately absent from the meta
    snapshot, so only the migration path installs the constraint this ticket is
    about. It is listed in drizzle/meta/_journal.json, so `migrate` picks it up.

    Not wrapped: a broken migration's own error is the useful one, and there is
    nothing to add to it.
  */
  await withClient(DATABASE, (client) =>
    migrate(drizzle(client), { migrationsFolder: MIGRATIONS_DIR }),
  );

  /*
    Set here, not in .env.local. Three things have to hold for every test to end
    up on this database, and it is worth knowing all three because breaking any
    one of them silently sends the suite somewhere else:

      1. Vitest spawns its test workers as child processes (the default `forks`
         pool) and it does so after globalSetup finishes, so they inherit this
         value. Switching to `pool: "threads"` would still share the same
         process, so that also works — but a pool that pre-spawned workers would
         not.
      2. `override: false` where vitest.setup.ts loads .env.local, so a leftover
         Cloud SQL URL there cannot replace what we just set.
      3. lib/db/index.ts connects on first query rather than at import. Not what
         makes the value correct — points 1 and 2 do that — but it is why a test
         that never touches the database needs no database at all.

    Together: a developer with a real Cloud SQL URL in .env.local cannot point
    the suite at production by accident.
  */
  process.env.DATABASE_URL = url(DATABASE);
}

export async function teardown() {
  // The data directory stays. Next run reuses the cluster and skips initdb.
  await postgres?.stop();
}

// True when the data directory already holds a Postgres cluster.
function hasCluster() {
  return stat(path.join(DATA_DIR, "PG_VERSION")).then(
    () => true,
    () => false,
  );
}

/*
  Run one query or migration on its own connection and always hand it back.

  The `finally` is the point. Without it a thrown error leaves the connection
  open, `teardown` then kills the server underneath it, and the dying client
  emits an `error` event. An `error` event with no listener is an uncaught
  exception in Node, so the developer's real failure would be buried under a
  `Connection terminated unexpectedly` crash. Hence the listener too — the same
  trap embedded-postgres notes at dist/index.js:283-285.

  Built from `url()` rather than `postgres.getPgClient()`, which defaults to host
  `localhost`. On Windows that resolves to ::1 first, and the server here is
  listening on IPv4.
*/
async function withClient<T>(
  database: string,
  // Named `run`, not `use`: eslint's React rules read `use(...)` as the `use`
  // hook and reject it inside a try block.
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    connectionString: url(database),
    /*
      Without this, `connect` waits forever. Anything that accepts the TCP
      connection but never speaks Postgres — a stray process holding the port —
      leaves the whole suite hanging with no output at all. Ten seconds, matching
      the pool in lib/db/index.ts, turns that into the error below.
    */
    connectionTimeoutMillis: 10_000,
  });
  client.on("error", remember);
  try {
    await client.connect();
    return await run(client);
  } finally {
    await client.end().catch(remember);
  }
}

/*
  The last few things Postgres said. Kept short: the useful lines are the most
  recent ones, and a full server log in a test failure is unreadable.
*/
const RECENT_LINES = 20;
const recent: string[] = [];

function remember(message: unknown) {
  const text = message instanceof Error ? message.message : String(message);
  recent.push(text.trimEnd());
  if (recent.length > RECENT_LINES) recent.shift();
}

// An error that says what Postgres said, and keeps the original as `cause`.
function explain(message: string, cause: unknown) {
  const log = recent.join("\n");
  return new Error(log ? `${message}\n\nPostgres said:\n${log}` : message, {
    cause,
  });
}

// Paths relative to this file, not to whatever directory Vitest was started in.
function fromHere(...segments: string[]) {
  return path.join(fileURLToPath(new URL("./", import.meta.url)), ...segments);
}
