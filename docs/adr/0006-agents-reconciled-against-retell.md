# ADR-0006: Reconcile the four Agents against Retell, and record their ids in Postgres

**Status:** Accepted
**Date:** 2026-08-12
**Relates to:** SPEC.md §4 (Templates), §7 (Retell Integration), §2 (env vars),
`docs/verification.md` A4, ADR-0003

## Context

SPEC.md §7 asks for a setup script that creates one Retell LLM + Agent per
Template — four of each — rather than four hand-built agents in a dashboard. Two
things follow that the spec does not settle, and they are coupled.

**Retell has no upsert.** `create-agent` always creates. So "re-running the script
does not silently create duplicates" is not a property of the API; it has to be
built. And re-running is not an edge case here: the Tool URLs and the webhook URL
are baked into the Agent at creation time from `APP_URL`, which is not known until
Cloud Run exists (ADR-0001). Re-running *is* the mechanism by which the Agents get
re-pointed after a deploy, and by which an edited prompt ships.

**Four Agents, one env var.** SPEC.md §2 and `.env.example` name a singular
`RETELL_AGENT_ID`. Four Templates need four ids, and nothing in the schema stored
one.

## Decision

Three parts, decided together.

1. **Identify Agents by a derived name, `callzie-<business_type>`,** and reconcile
   against `list-agents` on every run: create what is missing, update what exists
   in place, and **refuse to act when two Agents share a name.**
2. **Record the resulting `(llm_id, agent_id)` pairs in a `retell_agents` table**
   keyed by `business_type`.
3. **Drop `RETELL_AGENT_ID`** from `.env.example`, deviating from SPEC.md §2's
   env list.

Retell is the source of truth for what exists; the table is an output of
reconciling against it, never an input to it.

## Rationale

**Why match remotely rather than trust the recorded ids.** Reading `retell_agents`
first and updating whatever it names is one API call cheaper and wrong in the two
cases that matter: a database pointed at a different Retell workspace than the one
the ids came from, and a run that half-completed and left the table untouched.
Listing costs one call and is always right. The table is then cross-checked, and
`--dry-run` reports a disagreement rather than papering over it.

**Why update in place rather than skip what exists.** Skipping satisfies the
letter of "no duplicates" and breaks the actual workflow — the URLs cannot be
correct until after the deploy, so an Agent that is never updated is an Agent
whose four Tools point at `localhost` forever. The alternative to updating is
delete-and-recreate, which churns agent ids that queued Calls and `retell_agents`
rows already reference, for no benefit.

**Why stop on a duplicate name.** Retell does not enforce unique agent names, so
two can exist — from a dashboard copy, or an interrupted run. Picking one updates
an Agent that may not be the one being called; creating a third compounds the
mess. Both are worse than exiting non-zero and naming the ids.

**Why Postgres rather than env vars.** Four `RETELL_AGENT_ID_*` variables would
reproduce the exact gap this closes. The deploy injects six secrets and patches
`APP_URL` in separately; four more values means four `.env.example` lines, four
`--set-env-vars` entries, and a `gcloud run services update` after every re-run —
with the failure mode being a silent split-brain where local dev calls the right
Agent and production calls a dead one. They are also identifiers, not credentials,
so Secret Manager is not their home. Postgres is correct per environment by
construction, and **Cloud Run already receives `DATABASE_URL`, so nothing new is
wired into the deploy at all.**

**Why not a committed manifest file.** A generated JSON checked into the repo
needs no database and shows the ids in a diff, which is genuinely nicer for
review. It was rejected because the ids are workspace-scoped: the moment a second
Retell account exists — a teammate's, or a staging one — a committed file is
wrong for somebody, and the failure is silent (a valid-looking id that belongs to
another workspace). A row in the database that the deployment already talks to
cannot drift that way.

## Consequences

- **The script needs `DATABASE_URL`**, so provisioning now depends on the Cloud
  SQL Auth Proxy running locally. `--offline` and `--list-voices` deliberately do
  not, so prompts stay reviewable with no credentials at all.
- **`lib/db/index.ts` throws at module scope without `DATABASE_URL`**, so the
  script imports the database accessors dynamically rather than at the top.
- **The Web Call path reads a row to resolve a Business's Agent** (issue #11).
  It is a primary-key lookup on a four-row table, but it is a query where an env
  var would have been free.
- **Rotating `INTERNAL_SECRET`, or changing `APP_URL`, requires re-running the
  script** — both are baked into the Agents. Noted in `.env.example` next to each.
- **`RETELL_AGENT_ID` is gone**, which contradicts SPEC.md §2's env list and makes
  `docs/verification.md` A6's sample stale. A6 is corrected in the same change.

## Revisit if

- **A staging environment appears alongside production.** Two databases already
  give two correct answers, so this holds — but it is the moment to check that
  nothing has started assuming the ids are the same everywhere.
- **Agent configuration ever needs to vary per Business** rather than per Business
  Type. The table is keyed by `business_type`; that would be a different key and a
  different ADR, and it would collide with SPEC.md §14 rule 5.
