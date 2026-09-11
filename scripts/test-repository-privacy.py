#!/usr/bin/env python3
"""Regression checks for publication safeguards, using synthetic local fixtures."""
import contextlib
import importlib.util
import io
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).with_name('check-repository-privacy.py')
SPEC = importlib.util.spec_from_file_location('privacy', SCRIPT)
privacy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(privacy)


class PrivacyTests(unittest.TestCase):
    def test_private_paths_are_blocked_even_if_force_added(self):
        for name in ['.env.local', 'nested/.env.production', '.playwright-mcp/screenshot.png',
                     '.clerk/cache.json', 'private.key', 'customers.sqlite3', 'trace.har',
                     'service-account-prod.json', 'qa/recording.mp4']:
            with self.subTest(name=name):
                self.assertIsNotNone(privacy.blocked_path(name))
        for name in ['.env.example', 'drizzle/0000_schema.sql', 'public/maya-avatar.png']:
            self.assertIsNone(privacy.blocked_path(name))

    def test_personal_identifiers_are_detected_without_banning_api_paths(self):
        mailbox = 'synthetic-person' + '@' + 'gmail.com'
        home = '/' + 'Users' + '/' + 'synthetic-person' + '/project'
        call = 'call_' + 'a' * 24
        for value in [mailbox, home, call]:
            self.assertTrue(privacy.content_issues('notes.md', value.encode()))
        self.assertFalse(privacy.content_issues('oauth.ts', b'/users/me/settings/timezone'))
        self.assertFalse(privacy.content_issues('fixture.json', b'person@example.com'))

    def test_environment_template_rejects_filled_secret(self):
        self.assertTrue(privacy.content_issues('.env.example', b'INTERNAL_SECRET=synthetic-placeholder'))
        self.assertFalse(privacy.content_issues('.env.example', b'INTERNAL_SECRET=\nAPP_URL=http://localhost:3000'))

    def test_author_and_committer_both_require_private_email_setting(self):
        safe = b'Test <123+test@users.noreply.github.com> 1 +0000'
        unsafe = ('Test <synthetic' + '@' + 'gmail.com> 1 +0000').encode()
        with patch.object(privacy, 'git', side_effect=[safe, unsafe]):
            self.assertEqual(privacy.identity_issues()[0][0], 'Git committer')
        with patch.object(privacy, 'git', return_value=safe):
            self.assertEqual(privacy.identity_issues(), [])

    def test_staged_blob_is_scanned_instead_of_unstaged_replacement(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            target = root / 'fixture.txt'
            target.write_text('staged content')
            subprocess.run(['git', '-C', str(root), 'add', 'fixture.txt'], check=True)
            target.write_text('unstaged replacement')
            with patch.object(privacy, 'ROOT', root):
                entries = list(privacy.entries('staged', 'HEAD'))
                self.assertEqual(entries[0][2](), b'staged content')

    def test_scanner_blocks_synthetic_secret_without_printing_it(self):
        scanner = privacy.scanner()
        # Generated only in the temporary test fixture; never a real credential.
        token = 'ghp_' + ('A1b2C3d4E5f6G7h8I9j0' * 2)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            (root / '.gitleaks.toml').write_text('[extend]\nuseDefault = true\n')
            (root / 'fixture.txt').write_text('github_token=' + token)
            log = io.StringIO()
            with patch.object(privacy, 'ROOT', root), patch.object(privacy, 'scanner', return_value=scanner), contextlib.redirect_stderr(log):
                result = privacy.scan()
            self.assertEqual(result, 1)
            self.assertNotIn(token, log.getvalue())
            self.assertIn('secret pattern:', log.getvalue())

    def test_missing_scanner_fails_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(privacy, 'ROOT', Path(folder)), patch.object(privacy.shutil, 'which', return_value=None), patch.dict(privacy.os.environ, {}, clear=True):
                with self.assertRaises(RuntimeError):
                    privacy.scanner()


if __name__ == '__main__':
    unittest.main()
