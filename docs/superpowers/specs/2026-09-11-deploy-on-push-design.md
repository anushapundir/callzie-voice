# Deploy on push to main — design

**Status:** implemented, 2026-09-11.

## What

A GitHub Actions workflow deploys every push to `main` to the Cloud Run
service, doing exactly what a person did by hand until now: build the image
with Cloud Build, then deploy it.

## Decisions

Three choices were put to the owner. Each answer, and why it holds:

1. **GitHub authenticates with Workload Identity Federation, not a key file.**
   Google trusts GitHub's short-lived tokens for this one repository. A leaked
   repository or GitHub secret cannot deploy to the project, because there is
   no long-lived credential to leak.

2. **The workflow does not run tests.** Speed was preferred over a gate. The
   runbook says so plainly, so nobody assumes `main` is protected.

3. **The workflow does not run migrations.** Migrations stay a manual step,
   as they are today. The deployer service account therefore needs no route to
   the database and no `DATABASE_URL`.

## Pieces

- `.github/workflows/deploy.yml` — the workflow. Triggers on push to `main`
  and by hand. A concurrency group serialises deploys. Steps: check the three
  repository variables are set, authenticate, build tagged with the commit
  SHA, deploy only the image, curl the landing page and fail on anything but
  200.
- `scripts/setup-github-deploy.sh` — one-time, idempotent. Creates the
  identity pool and provider restricted to `anushapundir/callzie`, the
  `callzie-deployer` service account with the smallest set of roles that lets
  the two commands run, and the three repository variables.
- `docs/runbooks/deploying.md` — what deploys, what does not, how to roll
  back, how to deploy by hand.

## What the deployer can do

Start a Cloud Build, upload source to the build bucket, list the project's
bucket names, read build logs, read images in the `callzie` image repository,
act as the build and runtime service accounts, and create a revision of the
service. It cannot read Secret Manager and has no Cloud SQL role.

The first three of those were missing from the first version of the setup
script and were found by running the workflow and reading each failure. The
script grants all of them now.

## Out of scope

Preview deploys for pull requests, a test gate, automatic migrations, and
notifying anyone when a deploy fails. GitHub's own email on a failed workflow
covers the last one.
