# Stable Server Action Encryption Key — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` a single stable value, supplied from Secret Manager as a Docker build argument, so Server Action identifiers and closure encryption survive a rebuild.

**Architecture:** The key is a **build input**, not a runtime secret. Next salts every Server Action's identifier with it during `next build` (`serverReferenceHashSalt`) and writes it into the server reference manifest; there is no runtime equivalent for the salt. So Cloud Build reads it from Secret Manager into the build step's environment, passes it to `docker build --build-arg`, and the Cloud Run deploy does **not** set it. A guard in the `Dockerfile` fails the image build when the key is missing or malformed.

**Tech Stack:** Next.js 16.3.0 (Turbopack), Docker multi-stage build, Google Cloud Build, Secret Manager, Cloud Run, bash.

**Spec:** `docs/superpowers/specs/2026-08-14-server-actions-encryption-key-design.md`

**Note on tests:** This change is entirely configuration. The spec deliberately adds no unit tests — the risk is a missing setting, not logic. Verification is Task 7, which builds the app twice and compares the key Next actually baked in. That is the real test, and it runs against the artifact rather than a mock.

---

### Task 1: Document the variable in `.env.example`

**Files:**
- Modify: `.env.example` (insert a new section between the `# --- Internal ---` block ending at line 43 and the `# --- App ---` block starting at line 45)

- [ ] **Step 1: Add the new section**

Insert after the `INTERNAL_SECRET=` line and before `# --- App ---`:

```bash
# --- Build inputs (baked into the image by `next build`) ---------------------
# Next encrypts the variables an inline Server Action closes over, and salts the
# action's own id with the same key. Both happen at BUILD time, so this is a
# Docker build arg, not a Cloud Run secret — setting it only at runtime would
# change the encryption and not the id, which is worse than not setting it at
# all. See docs/adr/0008-server-actions-key-is-a-build-input.md.
#
# A stability value, not a per-environment one. The same key in every
# environment is correct; a fresh key per deploy is the bug it exists to
# prevent. Rotating it renames every Server Action, so references already
# rendered into someone's open tab stop resolving until they reload.
#
# Optional locally — `next dev` generates one and caches it for 14 days.
# Required for any deployed build. Generate with: openssl rand -base64 32
NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=
```

- [ ] **Step 2: Verify the file still reads in order**

Run: `git diff .env.example`
Expected: one added block, no other lines touched. The `# --- App ---` heading still follows it.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "Document NEXT_SERVER_ACTIONS_ENCRYPTION_KEY as a build input"
```

---

### Task 2: Accept and validate the key in the Dockerfile

**Files:**
- Modify: `Dockerfile` (builder stage, after the `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` block at lines 41-45)

The runner stage gets nothing. The key is consumed by `npm run build` and written into the build output; the running server reads it from there.

- [ ] **Step 1: Add the ARG, ENV and guard**

Insert between the `ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=...` line and `ENV NEXT_TELEMETRY_DISABLED=1`:

```dockerfile
# Next salts every Server Action's id with this key and bakes it into the build
# output, so it is a build input rather than a runtime secret — see
# docs/adr/0008-server-actions-key-is-a-build-input.md.
#
# Left unset, Next generates a random key instead, and inside Docker its key
# cache is disabled entirely (`getStorageDirectory` returns undefined when
# `is-docker` is true), so that is a different key on *every* image build. The
# resulting image works perfectly until a rolling deploy puts two revisions
# side by side and every action reference from the older one stops resolving.
# Nothing about the build would tell you. Hence the check, in the same spirit
# as the ICU check above.
ARG NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
ENV NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=$NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
RUN node -e "const k=process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY; if(!k){console.error('NEXT_SERVER_ACTIONS_ENCRYPTION_KEY is empty. Pass it with --build-arg (cloudbuild.yaml does). Generate one with: openssl rand -base64 32'); process.exit(1)} const n=Buffer.from(k,'base64').length; if(n!==16&&n!==24&&n!==32){console.error('NEXT_SERVER_ACTIONS_ENCRYPTION_KEY decodes to '+n+' bytes; AES needs 16, 24 or 32. Generate one with: openssl rand -base64 32'); process.exit(1)} console.log('Server Action encryption key: '+n+' bytes')"
```

- [ ] **Step 2: Verify the guard rejects a missing key**

Run:
```bash
node -e "const k=process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY; if(!k){console.error('empty'); process.exit(1)}"
echo "exit=$?"
```
Expected: prints `empty`, `exit=1`.

- [ ] **Step 3: Verify the guard accepts a real key**

Run:
```bash
NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=$(openssl rand -base64 32) node -e "const k=process.env.NEXT_SERVER_ACTIONS_ENCRYPTION_KEY; const n=Buffer.from(k,'base64').length; if(n!==16&&n!==24&&n!==32){process.exit(1)} console.log('Server Action encryption key: '+n+' bytes')"
```
Expected: `Server Action encryption key: 32 bytes`, exit 0.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "Take the Server Action encryption key as a build arg"
```

---

### Task 3: Supply the key from Secret Manager in `cloudbuild.yaml`

**Files:**
- Modify: `cloudbuild.yaml` (whole file — the header comment, the build step, and a new `availableSecrets` block)

The build step changes to `entrypoint: bash` so `$$NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` is expanded by the shell inside the step. A single `$` would be substituted by Cloud Build itself and the value would be recorded in the build.

- [ ] **Step 1: Replace the file**

```yaml
# Builds the Dockerfile with the build args Next.js needs.
#
# `gcloud run deploy --source .` cannot pass --build-arg, and Next inlines
# NEXT_PUBLIC_* at build time (see Dockerfile), so the image must be built here
# and deployed by tag rather than from source.
#
#   gcloud builds submit --config cloudbuild.yaml \
#     --substitutions=_IMAGE=<image>,_CLERK_PUBLISHABLE_KEY=<pk_...>
#
# Credentials for third-party services are deliberately NOT build args — they
# arrive at runtime from Secret Manager and never enter the image.
#
# NEXT_SERVER_ACTIONS_ENCRYPTION_KEY is the one exception, and it is a real one
# rather than a lapse. It is not a credential for anything: it is a build input
# Next salts every Server Action id with and then writes into its own build
# output, so it is inside the image by construction and no configuration avoids
# that. It still comes from Secret Manager, just here rather than at deploy —
# and as a secretEnv rather than a substitution, because substitutions are
# recorded in the build history. See
# docs/adr/0008-server-actions-key-is-a-build-input.md.

steps:
  - name: gcr.io/cloud-builders/docker
    entrypoint: bash
    secretEnv:
      - NEXT_SERVER_ACTIONS_ENCRYPTION_KEY
    args:
      - -c
      # $$VAR is what the step's shell expands. A single $ would be substituted
      # by Cloud Build before the step runs, putting the key in the build record.
      - |
        docker build \
          --build-arg=NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${_CLERK_PUBLISHABLE_KEY} \
          --build-arg=NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=$$NEXT_SERVER_ACTIONS_ENCRYPTION_KEY \
          --tag=${_IMAGE} \
          .

images:
  - ${_IMAGE}

options:
  logging: CLOUD_LOGGING_ONLY

availableSecrets:
  secretManager:
    - versionName: projects/$PROJECT_ID/secrets/callzie-server-actions-encryption-key/versions/latest
      env: NEXT_SERVER_ACTIONS_ENCRYPTION_KEY

substitutions:
  _IMAGE: ""
  _CLERK_PUBLISHABLE_KEY: ""
```

- [ ] **Step 2: Verify the YAML parses**

Run: `node -e "const y=require('fs').readFileSync('cloudbuild.yaml','utf8'); if(!/availableSecrets/.test(y)||!/secretEnv/.test(y)) process.exit(1); console.log('ok')"`
Expected: `ok`

- [ ] **Step 3: Confirm the key is not a substitution**

Run: `grep -n "_SERVER_ACTIONS\|_ENCRYPTION" cloudbuild.yaml`
Expected: no line defines it under `substitutions:` — it appears only under `secretEnv`, `availableSecrets`, and as `$$NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` in the docker command.

- [ ] **Step 4: Commit**

```bash
git add cloudbuild.yaml
git commit -m "Read the Server Action key from Secret Manager at build time"
```

---

### Task 4: Generate, store and grant the key in the setup wizard

**Files:**
- Modify: `scripts/setup-infrastructure.sh` (Stage 1 around line 246, Stage 6 around lines 379-396, Stage 7 note around line 401)

Three separate edits. The key is generated with the other locally-generated secret, stored beside the runtime secrets, but granted to a **different** service account — Cloud Build reads it, not Cloud Run.

- [ ] **Step 1: Generate the key in Stage 1**

Insert after the `INTERNAL_SECRET` block (immediately before the `printf '\n'` that precedes the KYC warning):

```bash
printf '\n'
say "One more generated value: the Server Action encryption key. Next salts"
say "every Server Action's id with it while building, so every build must use"
say "the same one — otherwise each deploy renames every action and anyone with"
say "an open tab starts getting errors. See ADR-0008."
if [[ -n "$(_existing NEXT_SERVER_ACTIONS_ENCRYPTION_KEY || true)" ]]; then
  note "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY already set — keeping it."
  note "Generating a fresh one here is exactly the thing to avoid."
else
  if command -v openssl >/dev/null 2>&1; then
    SERVER_ACTIONS_KEY=$(openssl rand -base64 32)
  else
    SERVER_ACTIONS_KEY=$(head -c 32 /dev/urandom | base64 | tr -d '\n')
  fi
  write_env NEXT_SERVER_ACTIONS_ENCRYPTION_KEY "$SERVER_ACTIONS_KEY"
fi
```

- [ ] **Step 2: Store the secret in Stage 6**

Add one line after `put_secret callzie-internal-secret ...`:

```bash
put_secret callzie-server-actions-encryption-key "$(_existing NEXT_SERVER_ACTIONS_ENCRYPTION_KEY)"
```

- [ ] **Step 3: Grant it to the build account, not the runtime one**

The existing `for s in ...` loop grants the Cloud **Run** runtime account and must stay as it is — do not add the new secret to that list. Insert this block immediately after `say "Access granted to $RUNTIME_SA"`:

```bash
printf '\n'
say "The Server Action key is read by Cloud BUILD, not Cloud Run — it is baked"
say "into the image rather than injected at boot, so it needs a different grant."
note "Which account a build runs as depends on a project setting: the legacy"
note "Cloud Build account, or the Compute default. Granting both is idempotent"
note "and costs nothing when one of them is unused."
for sa in "${PROJNUM}@cloudbuild.gserviceaccount.com" "${RUNTIME_SA}"; do
  "$GC" secrets add-iam-policy-binding callzie-server-actions-encryption-key \
    --member="serviceAccount:${sa}" \
    --role=roles/secretmanager.secretAccessor >/dev/null 2>&1 \
    || warn "could not grant $sa — grant it by hand before the first build"
done
```

- [ ] **Step 4: Extend the Stage 7 note**

Replace the two `note` lines under `stage "Build the image and deploy to Cloud Run" 12`:

```bash
note "The Clerk publishable key is a build arg because Next inlines NEXT_PUBLIC_*"
note "at build time, as is the Server Action encryption key, which Next bakes"
note "into its own build output. Cloud Build pulls that one from Secret Manager"
note "itself — it is not passed here. Every other server secret stays out of the"
note "image and arrives at runtime. The deploy below deliberately does not set"
note "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: at runtime it would override the"
note "decryption key without touching the ids, which is worse than leaving it."
```

- [ ] **Step 5: Verify the script still parses**

Run: `bash -n scripts/setup-infrastructure.sh`
Expected: no output, exit 0.

- [ ] **Step 6: Verify the runtime grant loop was not widened**

Run: `grep -n "callzie-server-actions-encryption-key" scripts/setup-infrastructure.sh`
Expected: exactly two hits — the `put_secret` line and the `add-iam-policy-binding` line. It must **not** appear in the `for s in ...` runtime loop or in the `--set-secrets` deploy flag.

- [ ] **Step 7: Commit**

```bash
git add scripts/setup-infrastructure.sh
git commit -m "Generate and store the Server Action key in the setup wizard"
```

---

### Task 5: Record the decision as ADR-0008

**Files:**
- Create: `docs/adr/0008-server-actions-key-is-a-build-input.md`

Numbering note: `docs/adr/` already contains two files numbered 0006. The highest number in use is 0007, so 0008 is free.

- [ ] **Step 1: Write the ADR**

```markdown
# ADR-0008: The Server Action encryption key is a build input, not a runtime secret

**Status:** Accepted
**Date:** 2026-08-14
**Amends:** `cloudbuild.yaml`'s rule that server-only secrets are never build args
**Resolves:** [#22](https://github.com/anushapundir/callzie/issues/22)

## Context

Next encrypts the variables an inline Server Action closes over. The key is
`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`, and issue #22 raised it as a multi-instance
hazard: Cloud Run runs several instances, and if they disagree on the key, a
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
generate. Worse, if the runtime value ever differed from the baked one, actions
that work today would begin failing — so the failure mode of getting it wrong is
worse than not setting it at all.

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

So the change is still worth making and the acceptance criteria still hold. The
value is stability across builds, not agreement between instances of one build.

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
this ADR is that ordinary deploys stop causing it and it becomes a rare,
deliberate event.

Rotate only on suspected exposure, and expect the one-reload blip.

## Consequences

- The `Dockerfile` fails the image build when the key is missing or is not a
  valid AES length. Without that, a missing key yields a working image with a
  random key — the exact defect, with no signal.
- `scripts/setup-infrastructure.sh` generates the key once and refuses to
  regenerate it on a re-run.
- Cloud Build's service account needs `secretAccessor` on the new secret. This is
  a different account from the Cloud Run runtime one the wizard already grants.

## Follow-up, not done here

`deploymentId`, which Next's self-hosting guide recommends alongside a stable key
to handle **asset** version skew during rollouts. A stable key fixes action
identifiers; it does not fix a client requesting a JS chunk the new revision no
longer serves. Related, real, and a separate decision.

## Revisit if

- Next changes where the action-id salt comes from. The runtime fallback order
  at `encryption-utils.js:78` is not documented behaviour — it was read from
  source. The documented path, and the one this ADR follows, is passing the key
  to `next build`.
- The project moves off a one-image-per-revision deploy model, at which point the
  original framing in #22 becomes the live concern again.
```

- [ ] **Step 2: Verify the ADR number is unused**

Run: `ls docs/adr/`
Expected: `0008-server-actions-key-is-a-build-input.md` is the only 0008.

- [ ] **Step 3: Commit**

```bash
git add docs/adr/0008-server-actions-key-is-a-build-input.md
git commit -m "ADR-0008: the Server Action key is a build input"
```

---

### Task 6: Correct the stale comment in the onboarding action

**Files:**
- Modify: `app/(onboarding)/onboarding/actions.ts:24-29`

The comment currently states the variable "is not yet in `.env.example`,
`cloudbuild.yaml` or the `Dockerfile`". After Tasks 1-3 that is false, and a
false comment about a security-adjacent property is worse than none.

- [ ] **Step 1: Replace the paragraph**

Replace lines 24-29 (the block beginning `* **This action closes over nothing`
and ending `* argument, that variable has to be set first.`) with:

```
 * **This action closes over nothing, deliberately.** Every input comes from
 * `FormData` or from `auth()`. That is no longer forced on us — since ADR-0008
 * the key Next uses to encrypt closed-over variables is a stable build input,
 * so a bound argument would work — but the property is still worth keeping.
 * Nothing here needs one, and not sending a value to the browser at all beats
 * encrypting it on the way. See docs/adr/0008-server-actions-key-is-a-build-input.md.
```

- [ ] **Step 2: Verify types still check**

Run: `npm run typecheck`
Expected: no errors. (A comment change cannot break it; this confirms nothing
adjacent was clipped.)

- [ ] **Step 3: Commit**

```bash
git add "app/(onboarding)/onboarding/actions.ts"
git commit -m "Update the stale encryption-key note in completeOnboarding"
```

---

### Task 7: Verify the key is baked in and stable

**Files:** none modified — this task proves the acceptance criteria.

`next build` writes the key it used into the `encryptionKey` field of
`.next/server/server-reference-manifest.json`. Comparing that field across builds
demonstrates the property directly, without a deployment.

- [ ] **Step 1: Build once with a fixed key**

```bash
KEY=$(openssl rand -base64 32)
echo "$KEY" > /tmp/callzie-test-key
NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="$KEY" npm run build
node -e "console.log(require('./.next/server/server-reference-manifest.json').encryptionKey)" > /tmp/callzie-build-1
cat /tmp/callzie-build-1
```
Expected: prints the same string as `$KEY`.

If the build fails for reasons unrelated to this change — a missing Clerk key,
say — set the minimum env it asks for and retry. The build must not be made to
pass by removing the encryption key.

- [ ] **Step 2: Build again with the same key**

```bash
rm -rf .next
NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=$(cat /tmp/callzie-test-key) npm run build
node -e "console.log(require('./.next/server/server-reference-manifest.json').encryptionKey)" > /tmp/callzie-build-2
diff /tmp/callzie-build-1 /tmp/callzie-build-2 && echo "STABLE"
```
Expected: `STABLE`. This is acceptance criterion 1 — every instance of every
build carries the identical key.

- [ ] **Step 3: Reproduce the defect without the key**

```bash
rm -rf .next .next/cache
npm run build
node -e "console.log(require('./.next/server/server-reference-manifest.json').encryptionKey)" > /tmp/callzie-build-3
diff /tmp/callzie-build-1 /tmp/callzie-build-3 || echo "DIFFERS — this is the bug"
```
Expected: `DIFFERS — this is the bug`. Confirms the field genuinely tracks the
key rather than being constant.

Note: outside Docker, Next caches its generated key in `.next/cache/.rscinfo`
for 14 days, so this step deletes the cache to see a fresh generation. Inside
Docker no cache exists at all, which is why every image build differs.

- [ ] **Step 4: Clean up**

```bash
rm -rf .next
rm -f /tmp/callzie-test-key /tmp/callzie-build-1 /tmp/callzie-build-2 /tmp/callzie-build-3
```

- [ ] **Step 5: Record the result on the issue**

```bash
gh issue comment 22 --body "Verified: two builds with the same NEXT_SERVER_ACTIONS_ENCRYPTION_KEY produce an identical \`encryptionKey\` in \`server-reference-manifest.json\`; a build without it differs. Resolution written up in ADR-0008 — the key had to become a build arg because it salts the Server Action id hash at build time, and the premise in this issue is corrected there (instances of one revision already agree; the exposure is across revisions)."
```

---

## Acceptance criteria mapping

| Criterion from #22 | Where it is met |
|---|---|
| Key set identically across all Cloud Run instances of a revision | Tasks 2 + 3 — one image per revision, key baked at build. Proved in Task 7 Step 2. |
| `.env.example` documents it and says why it must not differ per environment | Task 1 |
| A Server Action closing over a server value works across a multi-instance deployment | Task 7 — verified from the artifact rather than a live deploy, per the approved spec |
| The build-time-versus-runtime tension with `cloudbuild.yaml` is resolved in writing | Task 5 (ADR-0008) plus the amended header comment in Task 3 |
