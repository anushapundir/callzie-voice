# Repository privacy

Keep production secrets and personal data out of source control, issues, pull requests, releases, screenshots, recordings, and copied terminal output.

## Before committing

```sh
npm run privacy:install
npm run privacy:hooks
npm run privacy:check
```

The installer downloads a pinned official Gitleaks release, verifies a hardcoded SHA-256 checksum, and stores the binary in ignored `bin/`. It does not upload source code. Python 3 is required; on Windows, use WSL for the provided hooks.

The pre-commit hook scans the complete staged tree, including files added with `git add -f`, and requires GitHub noreply author and committer addresses. It checks secret patterns, sensitive filenames, personal mailbox addresses, personal home paths, and live-looking call identifiers. The pre-push hook checks the committed tree and runs Gitleaks across reachable history. Both fail if the scanner is unavailable.

Use the exact noreply address shown in your GitHub email settings:

```sh
git config --local user.email "YOUR_ID+YOUR_USERNAME@users.noreply.github.com"
```

Do not add a blanket scanner exception for tests, fixtures, Markdown, or environment templates. If a detection is a false positive, review the exact finding and make the narrowest justified change.

## Data and assets

- Keep real credentials only in ignored local environment files or your deployment secret manager. Credential fields in `.env.example` must remain empty.
- Use synthetic people and reserved fictional telephone numbers in examples. Prefer `+12025550101` or `+447700900123`. Never paste live call IDs, recording URLs, transcripts, or customer exports into fixtures or verification notes.
- Review images, video, audio, PDFs, archives, filenames and metadata manually. Text scanning cannot establish that these contain no private information.
- Browser captures, local databases, Clerk state, QA outputs, private keys and security reports are excluded from Git and Docker build contexts. Review any new output directory before using it.
- Developer tools can print live customer information. Ignoring `*.log` does not make copied console output safe to publish.
- Keep production container images and build output private. The current Next build embeds `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`; publishing source code does not require publishing production images.

## GitHub protection

Once committed and pushed, the `Repository privacy` workflow scans pull requests and pushes with read-only repository permissions. Configure it as a required status check before allowing merges, and enable GitHub secret scanning and push protection where available. CI runs after a push and is not a substitute for server-side push protection.

Hooks are local and can be bypassed; scanners have false negatives. A successful scan is evidence for the checks performed, never a guarantee that no private information can enter the repository.

## Historical data and incidents

Deleting a value in a new commit does not remove old commits, clones, forks, pull-request refs, releases, or caches. Before publication, review all history and commit metadata. A clean source snapshot in a new repository is an alternative to a coordinated history rewrite.

If a credential is exposed, revoke or rotate it first, then remove it from tracked files and historical copies. Coordinate history changes with collaborators. Do not force-push or change repository visibility as an automatic cleanup step.

Report sensitive findings through GitHub private vulnerability reporting if enabled, or arrange a private channel with the maintainer. Do not put secrets or customer information into a public issue.
