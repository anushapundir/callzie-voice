# Google refresh tokens are encrypted by the application, not by the database

Status: accepted

SPEC.md §5 annotates `businesses.google_refresh_token` as `-- encrypted at rest`, and
the column as shipped is plain `text` holding a plaintext token. That token is the
whole prize: it is long-lived, it survives the session, and it exchanges for an access
token carrying the `calendar.events` scope on the owner's real Google account. Anything
that can read the row can read the calendar of every Business that ever connected.

Callzie encrypts it in Node, in `lib/google/crypto.ts`, before it reaches Postgres.
**AES-256-GCM** — authenticated, so a tampered ciphertext fails to decrypt rather than
yielding attacker-chosen bytes — with a random 12-byte IV per encryption and the auth
tag stored alongside. The key is 32 raw bytes, base64 in `TOKEN_ENCRYPTION_KEY`, held in
Secret Manager as `callzie-token-encryption-key` and injected by Cloud Run at boot; it
is a **runtime** secret, so it stays out of `cloudbuild.yaml` and out of the image.

Stored values carry a **`v1:` prefix**. The scheme is therefore self-describing at rest,
which is what makes rotation possible at all: a `v2:` can be introduced and both read
concurrently while rows are re-encrypted, and a plaintext value from before this ADR is
distinguishable from a ciphertext by the absence of a prefix rather than by guesswork.
Deciding this after the first token is written is expensive; deciding it now costs three
characters a row.

## Considered options

- **`pgcrypto` — `pgp_sym_encrypt(token, key)` in the query.** Rejected because the key
  becomes part of the SQL text. Postgres logs statements (`log_statement`,
  `log_min_duration_statement`), Cloud SQL surfaces them in Cloud Logging, and
  `pg_stat_statements` retains normalised query text that a bound parameter does not
  reliably stay out of. The failure is that the key ends up in exactly the places
  operators grant broad read access to, and the encrypted column and its key then sit
  one join apart. It also puts the crypto behind the same credential as the data, which
  is the property the next option loses too.
- **A Cloud SQL customer-managed encryption key (CMEK).** Rejected because it defends
  the wrong boundary. CMEK encrypts the disk, and the threat here is not somebody
  carrying off a drive — it is a leaked `DATABASE_URL`, which is a single string that
  lives in `.env.local`, in Secret Manager, and in the shell history of anyone who has
  run the Auth Proxy. To a connection holding that string the row is plaintext, CMEK or
  not, because the storage layer decrypts for every authorised reader by design.
  Application-side encryption makes the token useless to anyone holding only the
  database credential, which is the realistic compromise. CMEK is complementary, not an
  alternative, and can be added later without touching this.
- **Plaintext, as the column does today.** Rejected: SPEC.md §5's own annotation already
  rules it out, and the gap between the annotation and the schema is the reason this ADR
  exists. It is worth naming rather than silently fixing, because "the comment said
  encrypted so it must be" is precisely how this survived review once.
- **Not storing a refresh token at all** — asking the owner to reconnect whenever the
  access token expires. Rejected: access tokens last an hour, and ADR-0004's one-way
  push runs when an Appointment is booked, which is whenever a Call happens rather than
  whenever somebody is watching. A reconnect prompt nobody is present to answer is a
  Collision generator.

## Consequences

- **Losing `TOKEN_ENCRYPTION_KEY` means every Business must reconnect Google.** The
  ciphertext is unrecoverable by construction; there is no escrow and no derivation from
  another secret, deliberately, since either would reintroduce a second copy of the key.
  This is recoverable precisely because ADR-0004 makes Google optional: a Business with
  no working calendar still takes Calls, still books Appointments and still shows
  Availability. Nothing but the calendar push stops. That is what makes the strong
  failure mode acceptable, and it is the reason this ADR would not be a safe pattern for,
  say, the Retell credentials.
- Rotation is possible but not automatic. It means adding `v2:`, reading both, and
  re-encrypting every row — real work that nobody will do under time pressure, so the
  prefix exists to keep it from being impossible rather than to make it routine.
- The encrypted column cannot be searched, indexed or compared in SQL. Nothing needs to:
  it is read by primary key, for one Business, at push time.
- Anything that reads `businesses.google_refresh_token` must go through
  `lib/google/crypto.ts`. A direct `select` yields a `v1:` blob, which is loud rather
  than subtly wrong — the intended failure shape.
- `TOKEN_ENCRYPTION_KEY` joins the configuration panel (issue #5) as an **optional**
  variable, alongside `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. A deployment with
  no Google integration and no key is correctly configured, not degraded.
