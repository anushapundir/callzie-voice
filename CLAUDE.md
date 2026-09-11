# Callzie

Build spec: `SPEC.md` — scope is locked to that document.

## How to talk to me

Write for a new engineer building their first full-stack product. That is the
audience for every reply, every plan, and every comment.

- **Plain English, short sentences.** Say "this runs before the test starts",
  not "this executes during the pre-test lifecycle hook".
- **Name the thing, then explain it.** The first time a term like `EXCLUDE
  constraint`, `globalSetup` or `IANA timezone` appears, add one short sentence
  saying what it is. Do not assume it is already known.
- **Lead with the answer.** Say what to do first, then why. Do not build up to
  it.
- **One idea per paragraph.** Break up anything longer than three or four lines.
- **Show the concrete example.** A real time like `09:00 → 09:45` beats an
  abstract description of an interval.
- **Say what could go wrong, in ordinary words.** "If two calls book the same
  time at once, one must lose" beats "a race condition exists in the
  check-then-write sequence".
- **Cut it if it is not needed.** No throat-clearing, no restating the question,
  no listing options that are not being recommended.
- **Recommend, do not survey.** When there is a choice, give the pick and one
  sentence of why. Alternatives only if they are genuinely live.
- **Skip the jargon unless it earns its place.** If a plain word works, use the
  plain word. If the technical term is the one that will show up in the code or
  the docs, use it and define it.

This applies to chat replies and to prose written into the repo (plans, specs,
ADRs, code comments). It does not change the code itself — variable names and
APIs still follow `CONTEXT.md`'s vocabulary.

## Agent skills

### Issue tracker

Issues live as GitHub issues, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, using their default label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Setting up a fresh worktree

A new worktree has no `.env.local` and no `node_modules`. Do these three things
before anything else, or you will lose time to failures that look like bugs in
the code and are not.

**1. Link the secrets.** Keep `.env.local` in your private primary checkout.
Set `CALLZIE_PRIMARY_WORKTREE` to that checkout locally; do not put your personal
path or environment values in tracked documentation. Link the file rather than
copying credentials between worktrees:

```powershell
New-Item -ItemType HardLink `
  -Path .env.local `
  -Target (Join-Path $env:CALLZIE_PRIMARY_WORKTREE ".env.local")
```

A hard link, not a symbolic link. Windows refuses to create a symbolic link
without Administrator rights; a hard link needs none, and both mean "the same
file under two names".

Check it worked with `wc -c .env.local` — it should be about 1 KB, not empty.
`.gitignore` already covers `.env.*`, so there is no risk of committing it.

If the link is missing later, OneDrive most likely re-created the file during a
sync, which breaks the link and leaves a stale copy behind. Delete `.env.local`
and run the command again.

**2. Install.** `npm install`. **Close OneDrive first.** OneDrive locks files
mid-install, and npm reports this as a wall of `TAR_ENTRY_ERROR UNKNOWN`
warnings rather than as an error — the install "succeeds" with truncated
packages. The one that bites is `@next/swc-win32-x64-msvc`, the native compiler
Next uses: a truncated copy makes `npm run build` fail with "Turbopack is not
supported on this platform", which is not what is wrong. Fix by reinstalling
that one package, or run `npm ci` from scratch.

**3. Check there is memory.** The test suite starts its own Postgres, and
`initdb` dies with `FATAL: out of memory` if the machine is short. OneDrive
alone can hold 3 GB. If tests fail before a single one runs, that is why.

### What needs what

`npm test` needs none of the above except `node_modules`. `vitest.globalSetup.ts`
starts a local Postgres and sets `DATABASE_URL` itself, so the suite runs on a
fresh worktree without secrets and without a network.

`npm run dev`, `npm run replay-webhook` and `npm run db:migrate` all need
`.env.local` **and** the Cloud SQL Auth Proxy — the small local program that
forwards `127.0.0.1:5432` to the real database (ADR-0001). Without the proxy
running they fail to connect, whatever is in `.env.local`.

`npm run typecheck` needs Next's generated route types, which only exist after
`next dev` or `next build` has run once. On a fresh worktree it reports
`Cannot find name 'PageProps'` in files nobody touched. Run `npx next typegen`
once and the errors go.

### Leave APP_URL pointing at the deployed app

`APP_URL` is the deployed Cloud Run URL, and it must stay that way. It looks
wrong when you are working locally. It is not.

Retell calls your webhook and your Tool endpoints **from its own servers**, so it
can never reach `localhost` whatever this is set to. Three things depend on the
deployed value:

- `scripts/create-agent.ts` freezes it into all four Retell Agents at creation
  time. `docs/verification.md` rules 27 and 28 spell out the damage — Agents that
  connect fine and fail every Tool call, which shows up mid-demo as Maya stalling
  rather than as an error anyone sees at creation.
- `lib/google/config.ts` builds the Google OAuth redirect URI from it, and Google
  only accepts a redirect URI already registered in the console.
- `scripts/setup-infrastructure.sh` writes the Cloud Run URL into it on purpose.

So a Call placed against a local dev server will never receive its webhooks, and
its transcript and extraction stay empty forever. That is expected, not a bug.

**To exercise webhook code locally, run `npm run replay-webhook`.** That is what
it is for, and SPEC.md §10 requires it to pass before any real Call. Override the
origin on the command line rather than editing the file — and match the port
`next dev` actually chose, which is not 3000 when another worktree already holds
it:

```bash
APP_URL=http://localhost:3000 npm run replay-webhook
```

A replay that dies partway leaves its throwaway Appointment behind, and the next
run then fails on the `appointments_no_overlap` constraint. Delete the leftover
row — its name starts with `replay-` — and run again.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
