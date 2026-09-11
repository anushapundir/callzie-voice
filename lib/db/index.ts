import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { schema } from "./schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * A transaction handle, as `db.transaction(...)` hands one to its callback.
 *
 * Derived rather than imported: `PgTransaction`'s type parameters have to match
 * the schema exactly, and spelling them out by hand is a thing that silently
 * drifts.
 */
export type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Something you can read through — the pool, or one transaction on it.
 *
 * **Why any of this exists.** The pool holds five connections. A function that
 * reads through `db` while its caller is inside a transaction takes a *second*
 * connection, and if enough requests do that at once, every transaction is
 * holding one connection and waiting for another that will never come free.
 * Postgres is idle and the app is deadlocked until `connectionTimeoutMillis`
 * expires ten seconds later.
 *
 * Ten seconds is longer than a Tool's whole budget (`lib/retell/tools.ts`), so
 * on the Tool path that deadlock is dead air on a live call — the failure mode
 * ADR-0003 calls the most damaging available to a voice product.
 *
 * So every reader that might be called from inside a transaction takes this and
 * defaults to `db`. Callers already in a transaction pass their own handle, and
 * no second connection is ever needed.
 */
export type Queryable = Db | Transaction;

let instance: Db | undefined;

/*
  Built on first use, never at import.

  `next build` imports every route module to collect page data, and the image is
  built without DATABASE_URL on purpose — server secrets arrive from Secret
  Manager at boot and never enter a layer (cloudbuild.yaml). Connecting at module
  scope therefore failed the production build on a variable that is correctly
  absent, while working locally where .env.local supplies one.

  The check still throws, just at the first query instead of at import, so a
  genuinely misconfigured container fails as loudly as before.
*/
function connect(): Db {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }

  // One pool per container, reused across requests. `db-f1-micro` has a low
  // max_connections ceiling, so keep this small: Cloud Run may run several
  // instances at once and each brings its own pool.
  //
  // The same URL works in both places, only the host differs:
  //   Cloud Run  → unix socket, ...@/callzie?host=/cloudsql/<CONNECTION_NAME>
  //   local      → TCP via the Cloud SQL Auth Proxy on 127.0.0.1:5432
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  return drizzle(pool, { schema });
}

/*
  A Proxy so the 19 call sites keep importing a plain `db`. Methods are bound to
  the real Drizzle instance rather than the Proxy, because Drizzle's builders
  read internals off `this`.
*/
export const db = new Proxy({} as Db, {
  get(_target, property, receiver) {
    instance ??= connect();
    const value = Reflect.get(instance, property, receiver);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

export { schema };
