# ADR-0008: The Server Action encryption key is a build input, not a runtime secret

**Status:** Accepted
**Date:** 2026-08-14
**Amends:** `cloudbuild.yaml`'s rule that server-only secrets are never build args
**Resolves:** [#22](https://github.com/anushapundir/callzie/issues/22)

## Context

Next encrypts the variables an inline Server Action closes over. The key is
`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, and issue #22 raised it as a multi-instance
hazard: Cloud Run runs several instances, and if they disagree on the key a
client can invoke an action reference one instance cannot decrypt.

Reading Next.js 16.3.0 changes both the fix and the reason for it.

## What the key does

Two jobs, not one:

1. **Encrypts closure variables.** At runtime the key resolves as
   `process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY || serverActionsManifest.encryptionKey`
   — `server/app-render/encryption-utils.js:78`.

2. **Salts the Server Action identifier hash.** The key is handed to SWC as
   `serverReferenceHashSalt` (`build/webpack-config.js:426`) and to Turbopack in
   the same role (`build/turbopack-build/impl.js:111`). Next 16 builds with
   Turbopack by default (ADR-0002), so that is the live path.

Job 2 happens only during `next build`. There is no runtime equivalent.

## Decision

Supply the key as a **Docker build argument**, sourced from Secret Manager by
Cloud Build. Do not set it on Cloud Run.

## Why not a runtime secret

The intuitive option, and the one `cloudbuild.yaml`'s existing rule points at.
It does not work. A runtime-only value changes which key decrypts closures while
leaving identifiers salted by whatever random key that build happened to
generate. Worse, if the runtime value ever drifted from the baked one, actions
that work today would begin failing — so getting this wrong is worse than not
setting the variable at all.

## Correcting the premise

The hazard in #22 is not the one Callzie has. Cloud Run serves one image per
revision, so every instance of a revision already carries the same baked key and
the same identifiers. They agree with each other today.

The real exposure is **across revisions**. `getStorageDirectory`
(`server/cache-dir.js:18-24`) returns `undefined` when `is-docker` reports a
container, disabling the key cache, so every image build starts from a fresh
random key and produces a different set of action identifiers. During a rollout,
or for any browser holding a page rendered by the previous revision, invoking an
action yields "Failed to find Server Action".

The change is still worth making and the acceptance criteria still hold. Only the
reason changes: the value is stability across builds, not agreement between
instances of one build.

## The narrowed rule

`cloudbuild.yaml` said server-only secrets are never build args. That becomes:

> Credentials for third-party services are never build args. Build inputs that
> Next bakes into its own output are, and this is the only one.

The key is inside the image unavoidably — Next writes it into the build output,
because that is how the runtime finds it. No configuration avoids this. What is
avoidable is the key appearing in the *build record*, which is why Cloud Build
reads it as a `secretEnv` rather than a `_SUBSTITUTION`. Containment otherwise
rests on Artifact Registry being private, which it already is.

## Rotation

Add a Secret Manager version, rebuild, redeploy.

Because the key names the actions, every action reference rendered before the
rotation stops resolving, and anyone with an open tab gets an error until they
reload. That is precisely what happens on **every** deploy today. The effect of
this ADR is that ordinary deploys stop causing it, and it becomes a rare,
deliberate event.

Rotate only on suspected exposure, and expect the one-reload blip.

## Consequences

- The `Dockerfile` fails the image build when the key is missing or is not a
  valid AES length. Without that, a missing key yields a working image with a
  random key — the exact defect, with no signal. A wrong length is worth catching
  for the same reason: it fails neither at build nor at boot, but inside
  `crypto.subtle.importKey` the first time a user invokes an action.
- `scripts/setup-infrastructure.sh` generates the key once and refuses to
  regenerate it on a re-run.
- Cloud Build's service account needs `secretAccessor` on the new secret. That is
  a different account from the Cloud Run runtime one the wizard already grants,
  and which of the two candidate accounts a build runs as depends on a project
  setting, so the wizard grants both.

## Follow-up, not done here

`deploymentId`, which Next's self-hosting guide recommends alongside a stable key
to handle **asset** version skew during rollouts. A stable key fixes action
identifiers; it does not fix a client requesting a JS chunk the new revision no
longer serves. Related, real, and a separate decision.

## Revisit if

- Next changes where the action-id salt comes from. The runtime fallback order at
  `encryption-utils.js:78` is not documented behaviour — it was read from source.
  The documented path, and the one this ADR follows, is passing the key to
  `next build`.
- The project moves off a one-image-per-revision deploy model, at which point the
  original framing in #22 becomes the live concern again.
