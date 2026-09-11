#!/usr/bin/env python3
"""Scan publishable Git content without printing matching values.

This supplements human review. It cannot determine whether arbitrary names,
images, recordings, or every possible secret encoding contain private data.
"""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PRIVATE_DIRS = {'.clerk', '.pgdata', '.scratch', '.playwright-mcp', '.codex',
                'qa', 'playwright-report', 'test-results', 'node_modules', '.git'}
PRIVATE_EXTENSIONS = {'.pem', '.key', '.p12', '.pfx', '.sqlite', '.sqlite3', '.db',
                      '.dump', '.log', '.har'}
CONTENT_RULES = {
    'personal email address': re.compile(
        r'[\w.%+\-]+@(?:gmail|hotmail|outlook|icloud|yahoo|protonmail|proton|live)\.(?:com|me)\b', re.I),
    'personal home directory': re.compile(
        r'(?:(?i:[A-Z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s<>`"\']+)'
        r'|/(?:Users|home)/[^/\s<>`"\']+)'),
    'live-looking provider call identifier': re.compile(r'\bcall_[a-f0-9]{20,}\b', re.I),
}


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args])


def blocked_path(name):
    p = PurePosixPath(name)
    if p.is_absolute() or '..' in p.parts:
        return 'unsafe path'
    if any(part in PRIVATE_DIRS for part in p.parts):
        return 'private/generated directory'
    if p.name == '.env' or (p.name.startswith('.env.') and p.name != '.env.example'):
        return 'environment file'
    if p.suffix.lower() in PRIVATE_EXTENSIONS or p.name.endswith('.sql.gz'):
        return 'credential, database, or debug artifact'
    if p.name == 'credentials.json' or (p.name.startswith('service-account') and p.suffix == '.json'):
        return 'credential export'
    if p.name.endswith(('-secrets.json', '-privacy-report.json')):
        return 'private scan report'
    return None


def content_issues(name, data):
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        return []  # Binary assets require a visual/audio review before publication.
    issues = []
    for line_number, line in enumerate(text.splitlines(), 1):
        for label, pattern in CONTENT_RULES.items():
            if pattern.search(line):
                issues.append((name, line_number, label))
        if PurePosixPath(name).name == '.env.example':
            match = re.match(r'\s*([A-Z0-9_]+)\s*=\s*(.*)', line)
            if match and re.search(r'KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL', match[1]):
                if match[2].strip().strip('"\''):
                    issues.append((name, line_number, 'credential field must be empty in .env.example'))
    return issues


def identity_issues():
    issues = []
    for role in ('AUTHOR', 'COMMITTER'):
        identity = git('var', f'GIT_{role}_IDENT').decode()
        match = re.search(r'<([^>]+)>', identity)
        if not match or not match[1].endswith('@users.noreply.github.com'):
            issues.append((f'Git {role.lower()}', 0, 'use your GitHub noreply email before committing'))
    return issues


def entries(mode, revision):
    if mode == 'staged':
        for entry in git('ls-files', '--stage', '-z').split(b'\0'):
            if not entry:
                continue
            metadata, name = entry.split(b'\t', 1)
            permissions, oid, stage = metadata.decode().split()
            if stage != '0':
                raise RuntimeError('Resolve merge conflicts before scanning the index.')
            yield name.decode(), permissions, lambda oid=oid: git('cat-file', 'blob', oid)
    elif mode == 'revision':
        # A resolved object ID avoids interpreting the revision as a Git option.
        oid = git('rev-parse', '--verify', f'{revision}^{{commit}}').decode().strip()
        for entry in git('ls-tree', '-r', '-z', oid).split(b'\0'):
            if not entry:
                continue
            metadata, name = entry.split(b'\t', 1)
            permissions, kind, blob = metadata.decode().split()
            yield name.decode(), permissions, lambda blob=blob: git('cat-file', 'blob', blob)
    else:
        for name in sorted(set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z').decode().split('\0'))):
            if not name:
                continue
            path = ROOT / name
            if path.is_symlink():
                yield name, '120000', lambda: b''
            elif path.is_file():
                yield name, '100644', path.read_bytes


def scanner():
    candidate = os.environ.get('GITLEAKS_BIN') or shutil.which('gitleaks')
    if not candidate and (ROOT / 'bin/gitleaks').is_file():
        candidate = str(ROOT / 'bin/gitleaks')
    if not candidate:
        raise RuntimeError('Gitleaks is required. Run npm run privacy:install, then retry.')
    return candidate


def scan(mode='worktree', revision='HEAD', check_identity=False):
    issues = identity_issues() if check_identity else []
    with tempfile.TemporaryDirectory(prefix='callzie-privacy-') as temporary:
        temporary = Path(temporary)
        report = temporary / 'report.json'
        snapshot = temporary / 'source'
        snapshot.mkdir()
        if mode == 'history':
            command = [scanner(), 'git', '--log-opts=--all', str(ROOT)]
            count = int(git('rev-list', '--all', '--count'))
        else:
            count = 0
            for name, permissions, read in entries(mode, revision):
                count += 1
                reason = blocked_path(name)
                if reason:
                    issues.append((name, 0, reason))
                    continue
                if permissions not in ('100644', '100755'):
                    issues.append((name, 0, 'symlink or submodule needs explicit publication review'))
                    continue
                data = read()
                issues.extend(content_issues(name, data))
                target = snapshot / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            command = [scanner(), 'dir', str(snapshot)]
        command.extend(['--no-banner', '--redact=100', '--log-level=error',
                        '--config', str(ROOT / '.gitleaks.toml'), '--report-format=json',
                        '--report-path', str(report)])
        result = subprocess.run(command, cwd=ROOT, capture_output=True)
        if result.returncode not in (0, 1) or not report.is_file():
            raise RuntimeError('Gitleaks failed; no clean result can be claimed. No raw scanner output was printed.')
        findings = json.loads(report.read_text())
        for finding in findings:
            name = finding.get('File', 'unknown')
            try:
                name = str(Path(name).relative_to(snapshot))
            except ValueError:
                pass
            issues.append((name, finding.get('StartLine', 0), 'secret pattern: ' + finding.get('RuleID', 'unknown')))
    if issues:
        print('Publication privacy check failed. Matched values are redacted.', file=sys.stderr)
        for name, line, reason in sorted(set(issues)):
            print(f'  {name}:{line}: {reason}', file=sys.stderr)
        return 1
    if mode == 'history':
        print(f'Gitleaks secret-pattern scan passed across {count} commits. This does not certify historical personal data or commit identities.')
    else:
        print(f'Privacy checks passed for {count} files ({mode}). Binary assets and personal-data provenance still need human review.')
    return 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--staged', action='store_true')
    group.add_argument('--revision')
    group.add_argument('--history', action='store_true')
    parser.add_argument('--check-identity', action='store_true')
    args = parser.parse_args()
    mode = 'staged' if args.staged else 'revision' if args.revision else 'history' if args.history else 'worktree'
    try:
        sys.exit(scan(mode, args.revision or 'HEAD', args.check_identity))
    except RuntimeError as error:
        print(f'Privacy check could not complete: {error}', file=sys.stderr)
        sys.exit(2)
    except (subprocess.CalledProcessError, OSError, ValueError) as error:
        print(f'Privacy check could not complete: {type(error).__name__}. Check local scanner and Git configuration; raw diagnostic values are suppressed.', file=sys.stderr)
        sys.exit(2)
