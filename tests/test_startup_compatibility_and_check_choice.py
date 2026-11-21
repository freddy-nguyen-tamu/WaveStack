"""Regression for incompatible manifest-writer signatures and optional GitHub scan.

No GitHub or source-site requests. The tests deliberately avoid modifying
site_specific/site_adapter.py or the installed user's state.
"""
import contextlib
import io
import json
import shutil
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

import run
from reusable import engine
from reusable.bridge_manifest import generate_installed_manifests
from reusable.browser_bridge import ensure_generated_extensions

ROOT = Path(__file__).resolve().parents[1]


class StartupContractTests(unittest.TestCase):
    def _fake_manifest_root(self, tmp):
        src = tmp / 'reusable' / 'browser_bridge_extension'
        src.mkdir(parents=True, exist_ok=True)
        for name in ('manifest.chrome.json', 'manifest.firefox.json',
                     'background.js', 'content.js', 'popup.html', 'popup.js'):
            shutil.copy2(ROOT/'reusable/browser_bridge_extension'/name, src/name)
        adapter = types.SimpleNamespace(
            EXTENSION_MATCHES=['https://reader.example/chapters/*'],
            ALLOWED_HOSTS=['reader.example'],
            BRIDGE_IMAGE_HOSTS=['img.example'])
        return adapter

    def test_manifest_writer_and_runtime_agree_on_port_keyword(self):
        with tempfile.TemporaryDirectory() as dirname:
            root=Path(dirname)
            adapter=self._fake_manifest_root(root)
            changed=generate_installed_manifests(root,adapter,port=19001)
            self.assertEqual(set(changed),{'chrome','firefox'})
            out=ensure_generated_extensions(root,adapter,19002)
            for browser in ('chrome','firefox'):
                data=json.loads((out/browser/'manifest.json').read_text())
                self.assertIn('http://127.0.0.1:19002/*',
                    data.get('host_permissions', [])+data['permissions'])
                self.assertIn('https://img.example/*',
                    data.get('host_permissions', [])+data['permissions'])
            self.assertEqual(generate_installed_manifests(root, adapter, port=19002),[])

    def test_preflight_detects_old_portless_manifest_writer(self):
        # This is the exact regression from the 61-chapter run: the preflight
        # must call the same port-taking signature that the runtime uses.
        with mock.patch('reusable.bridge_manifest.generate_installed_manifests',
                        new=lambda root, adapter: []):
            with contextlib.redirect_stderr(io.StringIO()) as stderr:
                with contextlib.redirect_stdout(io.StringIO()):
                    with self.assertRaises(SystemExit) as raised:
                        run._run_preflight()
        self.assertEqual(raised.exception.code,3)
        self.assertIn('unexpected keyword argument',stderr.getvalue())

    def test_answer_no_skips_initial_remote_check_only(self):
        prompts=[]
        with contextlib.redirect_stdout(io.StringIO()):
            result, run_tests=run._initial_github_check_choice(['--resume','--authorized'],
                interactive=True,prompt=lambda msg:(prompts.append(msg) or 'no'))
        self.assertIn('--skip-initial-github-check',result)
        self.assertFalse(run_tests)
        self.assertEqual(len(prompts),1)
        self.assertIn('GitHub',prompts[0])
        self.assertNotIn('--no-shutdown',result)

    def test_yes_or_enter_preserves_full_remote_check(self):
        for answer in ('', 'yes','y'):
            with self.subTest(answer=answer):
                with contextlib.redirect_stdout(io.StringIO()):
                    args, run_tests=run._initial_github_check_choice(['--resume'],interactive=True,
                         prompt=lambda _:answer)
                self.assertNotIn('--skip-initial-github-check',args)
                self.assertTrue(run_tests)

    def test_unattended_does_not_silently_skip(self):
        with contextlib.redirect_stdout(io.StringIO()):
            args, run_tests=run._initial_github_check_choice(['--resume'],interactive=False)
        self.assertNotIn('--skip-initial-github-check',args)
        self.assertTrue(run_tests)

    def test_command_line_skip_preserved_and_never_double_prompts(self):
        def unexpected(_):raise AssertionError('must not prompt')
        with contextlib.redirect_stdout(io.StringIO()):
            args, run_tests=run._initial_github_check_choice(['--resume','--skip-initial-github-check'],
                interactive=True,prompt=unexpected)
        self.assertEqual(args.count('--skip-initial-github-check'),1)
        self.assertTrue(run_tests)

    def test_optional_suites_are_skipped_but_release_contract_is_checked(self):
        with mock.patch.object(run.shutil, 'which', side_effect=AssertionError('node should not run')):
            with contextlib.redirect_stdout(io.StringIO()) as output:
                run._run_preflight(run_tests=False)
        self.assertIn('PREFLIGHT COMPATIBILITY PASSED', output.getvalue())

    def test_explicit_skip_avoids_historical_reconcile(self):
        with mock.patch.object(engine, 'credential_for_selected'), \
             mock.patch.object(engine, 'reconcile_github_archive') as audit, \
             mock.patch.object(engine, 'archive_is_complete', return_value=True), \
             mock.patch.object(engine, 'event') as log:
            engine._archive_run_once(types.SimpleNamespace(execute=lambda sql:types.SimpleNamespace(fetchone=lambda:(1,))), None, None, 1, True,
                                     skip_remote_reconcile=True)
        audit.assert_not_called()
        self.assertTrue(any(call.args[0] == 'GITHUB_INITIAL_RECONCILIATION_SKIPPED'
                            for call in log.call_args_list))

    def test_default_still_reconciles_remote_history(self):
        with mock.patch.object(engine, 'credential_for_selected'), \
             mock.patch.object(engine, 'reconcile_github_archive') as audit, \
             mock.patch.object(engine, 'archive_is_complete', return_value=True), \
             mock.patch.object(engine, 'event'):
            engine._archive_run_once(types.SimpleNamespace(execute=lambda sql:types.SimpleNamespace(fetchone=lambda:(1,))), None, None, 1, True)
        audit.assert_called_once()

    def test_engine_accepts_skip_and_forwards_it(self):
        parsed=engine.build_parser().parse_args(['--resume','--authorized','--skip-initial-github-check'])
        self.assertTrue(parsed.skip_initial_github_check)
        with mock.patch.object(engine, '_archive_run_once', return_value=None) as archive:
            engine.archive_run(None,None,'https://reader.example/chapters/1',5,True,
                               skip_initial_github_check=True)
            self.assertTrue(archive.call_args.kwargs['skip_remote_reconcile'])


if __name__=='__main__':
    unittest.main()
