# Deploying

**Deployment is manual and disabled by default in this public repository.**
Provision your own infrastructure first. Set `GCP_PROJECT_ID` and `GITHUB_REPO`
in your shell before running `scripts/setup-github-deploy.sh`. The script sets
the deployment repository variables. Then set `ENABLE_DEPLOYMENT=true` in your
repository variables and run **Deploy** from **Actions**, selecting `main`.
No credentials or production access are included with this source release.

## What the workflow does, and what it does not

It runs two commands, the same two a person runs by hand:

```bash
gcloud builds submit --config cloudbuild.yaml \
  --substitutions="_IMAGE=us-central1-docker.pkg.dev/YOUR_PROJECT_ID/callzie/callzie:<sha>,_CLERK_PUBLISHABLE_KEY=<pk_...>"

gcloud run deploy callzie --region=us-central1 --platform=managed \
  --image=us-central1-docker.pkg.dev/YOUR_PROJECT_ID/callzie/callzie:<sha>
```

`<sha>` is the commit being deployed. Every image is tagged with the commit
it was built from, so you can always tell what is running.

Only the image changes on deploy. Secrets, environment variables, the service
account, the Cloud SQL connection and the CPU setting all carry over from the
revision already running. Those were set once by
`scripts/setup-infrastructure.sh`; change them with `gcloud run services
update`, not through the workflow.

**It does not run the test suite.** A red test on `main` still goes live. Run
`npm test` before merging.

**It does not run database migrations.** If your change adds a file under
`drizzle/`, apply it yourself before merging, with the Cloud SQL Auth Proxy
running:

```bash
npm run db:migrate
```

Do it before, not after. New code that expects a column that is not there yet
fails every request until the migration lands. Old code with an extra column it
does not know about is fine.

## Rolling back

Deploy an older image. Find the commit you want in `git log`, then:

```bash
gcloud run deploy callzie --region=us-central1 --platform=managed \
  --image=us-central1-docker.pkg.dev/YOUR_PROJECT_ID/callzie/callzie:<older sha>
```

This takes under a minute, because the image already exists. Before the next manual deployment, also revert the bad commit.

Images built before the workflow existed are tagged `latest`, not with a SHA.

## Deploying by hand

Run the two commands above from a checkout of the commit you want, with the
Clerk publishable key from `.env.local`. Nothing stops a manual deploy and an
another manual one from racing; do not merge to `main` while you are mid-deploy.

## How GitHub is allowed to deploy

GitHub proves who it is with a short-lived token that Google checks. This is
called Workload Identity Federation. There is no key file anywhere: not in the
repository, not in GitHub's secrets.

Google only accepts tokens issued for the the repository you configured repository,
and a token that passes becomes the service account
`callzie-deployer@YOUR_PROJECT_ID.iam.gserviceaccount.com`. That account can start a
build and deploy the service, and nothing else. It cannot read a secret or
reach the database.

`scripts/setup-github-deploy.sh` created all of this, and it is safe to run
again if something is missing. It also sets the three repository variables the
workflow reads: the identity provider, the deployer's email, and the Clerk
publishable key.

## When a deploy fails

- **"Refuse to run with the variables unset"** — a repository variable is
  missing. Run `scripts/setup-github-deploy.sh`.
- **Auth step fails** — the pool, provider or service account is gone, or the
  repository was renamed. Fix the name in the setup script and run it again.
- **Cloud Build fails** — read the build log linked from the step. The
  Dockerfile's own checks, for the ICU catalogue and the Server Action key,
  fail here on purpose rather than in production.
- **"Check the new revision answers" fails** — the container started but the
  landing page did not return 200. Cloud Run keeps the previous revision
  serving only if the new one fails its start-up probe, so check the service
  logs and roll back if needed.
