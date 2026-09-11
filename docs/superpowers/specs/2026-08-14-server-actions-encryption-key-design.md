# Design: a stable Server Action encryption key

**Issue:** [#22](https://github.com/anushapundir/callzie/issues/22)
**Date:** 2026-08-14
**Status:** Approved, not yet implemented

## Summary

Set `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` from Secret Manager as a **build input**
to the Docker image, so Server Action identifiers and closure encryption stay
stable across rebuilds. Record the decision as ADR-0008.

## What the key actually does

Read from Next.js 16.3.0 in `node_modules`, not from memory. The key has two
jobs, and the second one is the load-bearing one:

1. **Encrypts closure variables.** At runtime Next resolves the key as
   `process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY || serverActionsManifest.encryptionKey`
   — `server/app-render/encryption-utils.js:78`.

2. **Salts the Server Action identifier hash.** The key is passed to SWC as
   `serverReferenceHashSalt` (`build/webpack-config.js:426`, `:452`, `:1964`) and
   to Turbopack in the same role (`build/turbopack-build/impl.js:111`, `:210`).
   Next 16 builds with Turbopack by default (ADR-0002), so that is the live path.

Job 2 happens **only** during `next build`. There is no runtime equivalent. The
build-time value is generated in `build/index.js:646` and written into the server
reference manifest, which is what the runtime falls back to.

### Two consequences

**A runtime-only variable does not solve this, and can break it.** Setting the
variable on Cloud Run alone would change which key decrypts closures while
leaving identifiers salted by the random build-time key. If the runtime value
differed from the baked one, actions that work today would start failing. The
variable therefore has to be present at build time, and the tension named in
`cloudbuild.yaml` cannot be side-stepped.

**Every Docker build currently invents a new key.** `getStorageDirectory`
(`server/cache-dir.js:18-24`) returns `undefined` when `is-docker` reports a
container, which disables the `.rscinfo` key cache. Outside Docker the key is
cached for 14 days; inside Docker there is no cache at all, so each image build
starts from a fresh random key.

## Correcting the issue's premise

Issue #22 frames the risk as "a client can invoke an action reference one
instance cannot decrypt" across Cloud Run instances. That specific failure does
not exist here: Cloud Run serves one image per revision, so every instance of a
revision already carries the same baked key and the same identifiers.

The real exposure is **across revisions**. Each rebuild produces different action
identifiers, so during a rollout — or for any browser holding a page rendered by
the previous revision — invoking an action yields "Failed to find Server Action".
Today that is invisible because the one existing action, `completeOnboarding`,
resolves through a route that reloads. It stops being invisible as soon as an
action binds an argument.

The change is still worth making, and the acceptance criteria still hold. Only
the reason changes: the value is **stability across builds**, not agreement
between instances of one build.

## The design

### Delivery: Secret Manager into the build step

`cloudbuild.yaml` declares the secret under `availableSecrets` and the build step
reads it as `secretEnv`. The step switches to `entrypoint: bash` so the shell
expands `$$NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` inside the step, rather than the
value being recorded in the step's arguments.

Rejected: passing it as a `_SUBSTITUTION` like `_CLERK_PUBLISHABLE_KEY`.
Substitutions are stored in the build record and readable by anyone with build
history access. That is correct for a Clerk *publishable* key, which is public by
design, and wrong for this one.

### The key is inside the image, deliberately

Next writes the key into the build output — that is how the runtime finds it.
No configuration avoids this. So `cloudbuild.yaml`'s current rule, "server-only
secrets are deliberately NOT build args", narrows to:

> Credentials for third-party services are never build args. Build inputs that
> Next bakes into the output are, and this one is.

Containment rests on Artifact Registry being private, which it already is.

### Not set at runtime

The Cloud Run deploy does **not** gain this variable. Setting it there would be
redundant at best, and a silent breakage if it ever drifted from the baked value.
Absent at runtime is the safest configuration.

### Fail the build when it is missing

The `Dockerfile` gains a guard `RUN` in the builder stage that exits non-zero if
the argument is empty or does not base64-decode to 16, 24, or 32 bytes. Without
it, a missing key produces a working build with a random key — the exact defect
this change exists to prevent, with no signal. This follows the ICU check already
in the `Dockerfile`, whose comment states the principle: failing the image build
is the cheap place to find out.

A wrong-length key is worth catching for the same reason. It does not fail at
build or boot; it fails inside `crypto.subtle.importKey` the first time a user
invokes an action.

### Local development

Optional. `next dev` generates and caches a key in `.next/cache/.rscinfo` for 14
days, which is sufficient on one machine. The wizard writes a key to `.env.local`
regardless, so a single value exists locally before it reaches Secret Manager.

## File-by-file changes

| File | Change |
|---|---|
| `.env.example` | New entry under a `# --- Build inputs ---` heading. The comment must say it is a stability value, not a per-environment one: the same key everywhere is correct, and a fresh key per deploy is the bug. |
| `Dockerfile` | `ARG` + `ENV` in the **builder** stage beside the Clerk arg, plus the validation `RUN`. Nothing in the runner stage. |
| `cloudbuild.yaml` | `availableSecrets` block for `callzie-server-actions-encryption-key`; build step becomes `entrypoint: bash`; header comment amended to the narrowed rule. |
| `scripts/setup-infrastructure.sh` | Stage 1 generates the key with `openssl rand -base64 32` when `.env.local` has none. Stage 6 stores it with the existing `put_secret` and grants `secretAccessor` to the Cloud Build service account. Stage 7's `--set-secrets` is unchanged. |
| `docs/adr/0008-server-actions-key-is-a-build-input.md` | The written resolution. |
| `app/(onboarding)/onboarding/actions.ts` | The doc comment says the variable "is not yet in `.env.example`, `cloudbuild.yaml` or the `Dockerfile`". That becomes false; rewrite it to point at ADR-0008. |

### The service account is not the one the wizard already grants

Stage 6's existing loop grants the Cloud **Run** runtime service account. This
secret is read by Cloud **Build** — a different account in a different phase.
Which account a `gcloud builds submit` runs as depends on a project setting: the
legacy `PROJNUM@cloudbuild.gserviceaccount.com` or the Compute default
`PROJNUM-compute@developer.gserviceaccount.com`. The wizard grants both. The
grants are idempotent and cost nothing when one is unused.

## Verification

`next build` writes the key it used into the `encryptionKey` field of
`.next/server/server-reference-manifest.json`. That makes the property checkable
from the artifact, without a deployment. Read it out of the builder stage —
`docker build --target builder`, then `cat` the file — because the guard makes
the full build unrunnable without a key anyway:

1. Build twice with the same key; `encryptionKey` matches across both builds and
   equals the key passed in.
2. Build twice with the guard bypassed and no key; `encryptionKey` differs
   between the two — the defect, reproduced.

This demonstrates what acceptance criterion 3 is really asking about — every
instance and every rebuild agreeing — more directly than a live multi-instance
test would, because it inspects the value itself rather than an effect of it.

Acceptance criteria 1, 2 and 4 are satisfied by the file changes above.

## Rotation

Rotating means: add a Secret Manager version, rebuild, redeploy.

Because the key salts the identifiers, every action reference rendered before the
rotation stops resolving. Anyone with an open tab gets an error until they
reload. That is precisely what happens on **every** deploy today. The effect of
this change is that ordinary deploys stop causing it, and it becomes a rare,
deliberate event.

Rotate only on suspected exposure. Expect the one-reload blip.

## Out of scope

`deploymentId`, which the same Next.js self-hosting guide recommends alongside a
stable key to handle asset version skew during rollouts. Real and related, but a
separate concern with its own trade-offs. ADR-0008 records it as follow-up.

No new Server Action is written, and no test is added beyond the Dockerfile
guard. The risk here is a missing setting, not tricky logic.
