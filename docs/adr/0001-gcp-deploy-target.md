# ADR-0001: Deploy to Cloud Run + Cloud SQL instead of Vercel + Neon

**Status:** Accepted
**Date:** 2026-08-06
**Supersedes:** SPEC.md §2 (stack table), §1 (deliverable 1)

## Context

SPEC.md fixes the stack to Next.js on Vercel with Postgres on Neon, and names
"live deployed URL on Vercel" as deliverable 1. Research in `docs/verification.md`
(§C) confirmed that stack is technically sufficient: Vercel Hobby's 300s function
limit covers the extraction path with ~30x headroom, and Neon's free tier scales
to zero without pausing.

The builder has chosen to move to Google Cloud instead, for two stated reasons:
hands-on GCP experience, and access to the $300 / 90-day trial credit.

## Decision

Host the Next.js app on **Cloud Run** and Postgres on **Cloud SQL for PostgreSQL**.

Cloud Run and Cloud SQL are adopted together, as a pair. This is the load-bearing
part of the decision — see Consequences.

## Why the pair, and not Vercel + Cloud SQL

Cloud SQL authorises database connections by IP allowlist. Vercel serverless
functions have dynamic egress IPs, and static IPs are not available on Hobby.
Connecting Vercel to Cloud SQL therefore requires allowlisting `0.0.0.0/0` —
exposing the instance to the public internet with only a password in front of it
([Cloud SQL — Configure public IP](https://cloud.google.com/sql/docs/postgres/configure-ip)).

Cloud Run connects to Cloud SQL through a native connector with no public
allowlist, so the pairing removes the exposure rather than mitigating it.

## Consequences

**Accepted costs:**

- Deliverable 1 in SPEC.md changes from "live deployed URL on Vercel" to
  "live deployed URL on Cloud Run". The demo requirement itself is unchanged.
- Day 1 gains roughly 3 hours of infrastructure work not in the original plan:
  Dockerfile, Next.js standalone output, Artifact Registry, Secret Manager,
  Cloud SQL connector wiring. SPEC.md §11 budgets 5 days total and §11 says
  anything unfinished by Day 4 gets cut — this eats into that margin.
- Postgres is no longer free. Cheapest real Cloud SQL instance is ~$9.37/month
  with no SLA at that size (`docs/verification.md` §B4). It is credit-funded,
  not free-tier — GCP has no Always Free Postgres of any kind.

**Time bomb — must be planned for:**

The $300 credit expires after 90 days. On expiry the trial billing account
closes and **all associated projects and resources are deleted** after a grace
period ([Google — Free trial](https://docs.cloud.google.com/free/docs/free-cloud-features)).
A demo URL built on the trial stops working roughly three months after it is
first shown. Either upgrade to a paid billing account before day 90, or accept
that the live URL has an expiry date and keep the demo video as the durable
artefact.

An idle public IPv4 bills at $0.01/hour (~$7.30/month) even while the instance
is stopped, so "stop the instance to save credit" does not fully stop the spend.

**Unchanged:**

Everything else in SPEC.md. Retell integration, webhook idempotency and
signature verification, the extraction pipeline, the data model, and the UI are
all deployment-target agnostic. Drizzle migrations run against Cloud SQL exactly
as they would against Neon.

## Revisit if

- The $300 credit turns out to be unavailable on this account (already-used
  trial). Without it, this decision costs real money for a portfolio project and
  Vercel + Neon becomes correct again.
- Day 1 infrastructure work overruns and threatens the Day 2 kill-switch gate in
  SPEC.md §11. Shipping the product beats shipping the infrastructure.
