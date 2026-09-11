#!/usr/bin/env bash
#
# One-time setup so GitHub Actions can deploy main to Cloud Run.
#
# Run it from the repo root, logged in to both gcloud and gh as an owner of the
# project and the repository. It is safe to run again: every step checks for
# the thing it creates and skips it if it is already there.
#
#   bash scripts/setup-github-deploy.sh
#
# What it does, in plain words:
#
#   1. Tells Google to trust GitHub's own sign-in tokens, but only the ones
#      GitHub issues for this repository. This is "Workload Identity
#      Federation": no key file is created, so there is nothing to leak or
#      rotate.
#   2. Creates a service account, callzie-deployer, that can do exactly two
#      things: start a Cloud Build, and deploy to the Cloud Run service. It
#      cannot read secrets or the database.
#   3. Writes the three repository variables .github/workflows/deploy.yml reads.
#
# See docs/runbooks/deploying.md for how deploys work after this.

set -euo pipefail

# gcloud ships as gcloud.cmd on Windows; resolve it once so Git Bash works.
GC="gcloud"
command -v gcloud >/dev/null 2>&1 || GC="gcloud.cmd"

PROJECT_ID="${GCP_PROJECT_ID:?Set GCP_PROJECT_ID to your own Google Cloud project}"
REGION="us-central1"
SERVICE="callzie"
GITHUB_REPO="${GITHUB_REPO:?Set GITHUB_REPO to the owner/name of your own repository}"

POOL="github"
PROVIDER="github"
DEPLOYER="callzie-deployer"
# The service account the Cloud Run service runs as. The deployer must be
# allowed to "act as" it, or Cloud Run refuses to create a revision.
RUNTIME_SA="callzie-run@${PROJECT_ID}.iam.gserviceaccount.com"

say()  { printf '%s\n' "$*"; }
skip() { printf '  already there: %s\n' "$*"; }

PROJNUM=$("$GC" projects describe "$PROJECT_ID" --format='value(projectNumber)')
DEPLOYER_EMAIL="${DEPLOYER}@${PROJECT_ID}.iam.gserviceaccount.com"
# Cloud Build runs as this account. The deployer must be allowed to act as it
# to submit a build.
BUILD_SA="${PROJNUM}-compute@developer.gserviceaccount.com"
POOL_PATH="projects/${PROJNUM}/locations/global/workloadIdentityPools/${POOL}"
PROVIDER_PATH="${POOL_PATH}/providers/${PROVIDER}"

say "Project ${PROJECT_ID} (${PROJNUM}), repository ${GITHUB_REPO}"

# ── 1. Let Google verify GitHub's tokens ────────────────────────────────────
say ""
say "1. Trusting GitHub's tokens for ${GITHUB_REPO}"
"$GC" services enable iamcredentials.googleapis.com sts.googleapis.com \
  --project="$PROJECT_ID" >/dev/null

if "$GC" iam workload-identity-pools describe "$POOL" \
     --project="$PROJECT_ID" --location=global >/dev/null 2>&1; then
  skip "pool ${POOL}"
else
  "$GC" iam workload-identity-pools create "$POOL" \
    --project="$PROJECT_ID" --location=global \
    --display-name="GitHub Actions" >/dev/null
  say "  created pool ${POOL}"
fi

if "$GC" iam workload-identity-pools providers describe "$PROVIDER" \
     --project="$PROJECT_ID" --location=global \
     --workload-identity-pool="$POOL" >/dev/null 2>&1; then
  skip "provider ${PROVIDER}"
else
  # attribute-condition is the part that matters: without it, a token from ANY
  # GitHub repository would be accepted.
  "$GC" iam workload-identity-pools providers create-oidc "$PROVIDER" \
    --project="$PROJECT_ID" --location=global \
    --workload-identity-pool="$POOL" \
    --display-name="GitHub" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition="assertion.repository == '${GITHUB_REPO}'" >/dev/null
  say "  created provider ${PROVIDER}, limited to ${GITHUB_REPO}"
fi

# ── 2. The deployer service account and its rights ──────────────────────────
say ""
say "2. Service account ${DEPLOYER_EMAIL}"
if "$GC" iam service-accounts describe "$DEPLOYER_EMAIL" \
     --project="$PROJECT_ID" >/dev/null 2>&1; then
  skip "service account"
else
  "$GC" iam service-accounts create "$DEPLOYER" \
    --project="$PROJECT_ID" \
    --display-name="GitHub Actions deployer" \
    --description="Builds the image and deploys ${SERVICE}. Used only by .github/workflows/deploy.yml." >/dev/null
  say "  created"
fi

# Project-wide roles. Each one is the smallest that lets one workflow step run.
#   cloudbuild.builds.editor       start a build and watch it
#   run.admin                      create a new revision of the service
#   logging.viewer                 stream the build log into the Actions log
#   serviceusage.serviceUsageConsumer  make API calls billed to this project
for role in roles/cloudbuild.builds.editor roles/run.admin \
            roles/logging.viewer roles/serviceusage.serviceUsageConsumer; do
  "$GC" projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${DEPLOYER_EMAIL}" --role="$role" \
    --condition=None >/dev/null
done
say "  project roles granted"

# `gcloud builds submit` uploads the source to this bucket first.
"$GC" storage buckets add-iam-policy-binding "gs://${PROJECT_ID}_cloudbuild" \
  --member="serviceAccount:${DEPLOYER_EMAIL}" \
  --role=roles/storage.objectAdmin >/dev/null

# Before it uploads, gcloud lists the project's buckets to prove this one is
# really ours and not a look-alike someone else created (bucket squatting).
# Listing buckets is a project-level permission, so no role on the bucket
# itself can grant it: the first automatic run failed here with "forbidden from
# accessing the bucket". bucketViewer is the smallest role that includes it. It
# can see bucket names and settings, and cannot read a single object.
"$GC" projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${DEPLOYER_EMAIL}" \
  --role=roles/storage.bucketViewer --condition=None >/dev/null
say "  can upload source to gs://${PROJECT_ID}_cloudbuild"

# Cloud Build pushes the image as its own account, so the deployer never
# writes to the image repository. It still has to READ it: Cloud Run checks
# that whoever runs `run deploy` can read the image they name, and the third
# automatic run failed there with "downloadArtifacts denied".
"$GC" artifacts repositories add-iam-policy-binding "$SERVICE"   --project="$PROJECT_ID" --location="$REGION"   --member="serviceAccount:${DEPLOYER_EMAIL}"   --role=roles/artifactregistry.reader >/dev/null
say "  can read images in the ${SERVICE} repository"

# "Act as" rights: needed to hand a build to the build account, and a revision
# to the runtime account. Neither grants the deployer those accounts' powers
# directly.
for sa in "$BUILD_SA" "$RUNTIME_SA"; do
  "$GC" iam service-accounts add-iam-policy-binding "$sa" \
    --project="$PROJECT_ID" \
    --member="serviceAccount:${DEPLOYER_EMAIL}" \
    --role=roles/iam.serviceAccountUser >/dev/null
done
say "  can act as the build and runtime accounts"

# The link between the two halves: a GitHub token for this repository may
# become the deployer.
"$GC" iam service-accounts add-iam-policy-binding "$DEPLOYER_EMAIL" \
  --project="$PROJECT_ID" \
  --member="principalSet://iam.googleapis.com/${POOL_PATH}/attribute.repository/${GITHUB_REPO}" \
  --role=roles/iam.workloadIdentityUser >/dev/null
say "  GitHub tokens for ${GITHUB_REPO} may become it"

# ── 3. Repository variables the workflow reads ──────────────────────────────
say ""
say "3. GitHub repository variables"
CLERK_PK=$(grep -E '^NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=' .env.local | cut -d= -f2- | tr -d '\r"')
if [ -z "$CLERK_PK" ]; then
  say "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is not in .env.local; cannot continue." >&2
  exit 1
fi
# These are variables, not secrets: none of them is confidential. The Clerk
# publishable key is, as the name says, public — it ships in the browser bundle.
gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --repo "$GITHUB_REPO" --body "$PROVIDER_PATH"
gh variable set GCP_PROJECT_ID --repo "$GITHUB_REPO" --body "$PROJECT_ID"
gh variable set GCP_DEPLOYER_SERVICE_ACCOUNT   --repo "$GITHUB_REPO" --body "$DEPLOYER_EMAIL"
gh variable set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY --repo "$GITHUB_REPO" --body "$CLERK_PK"
say "  set GCP_WORKLOAD_IDENTITY_PROVIDER, GCP_DEPLOYER_SERVICE_ACCOUNT, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"

say ""
say "Done. Set ENABLE_DEPLOYMENT=true in your repository variables, then run Deploy manually from Actions."
