"""Opt-out must skip only shared reader publication, never archive integrity."""
import ast
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]


def get_prompt():
    source = (ROOT / 'run.py').read_text(encoding='utf-8-sig')
    functions = [n for n in ast.parse(source).body
                 if isinstance(n, ast.FunctionDef) and n.name == '_open_reader_sync_choice']
    assert len(functions) == 1
    ns = {'sys': sys}
    exec(compile(ast.Module(body=functions, type_ignores=[]), 'run.py', 'exec'), ns)
    return ns['_open_reader_sync_choice']


def apply_engine_skip(**updates):
    source = (ROOT / 'reusable/engine.py').read_text(encoding='utf-8-sig')
    tree = ast.parse(source)
    main = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'main')
    blocks = [n for n in main.body if isinstance(n, ast.If)
              and isinstance(n.test, ast.Attribute) and n.test.attr == 'skip_open_reader_sync']
    assert len(blocks) == 1
    ns = {'args': SimpleNamespace(skip_open_reader_sync=False, cloudflare_mode='shared-worker',
                                  deploy=True, shutdown_on_complete=False)}
    for key, value in updates.items():
        setattr(ns['args'], key, value)
    exec(compile(ast.Module(body=blocks, type_ignores=[]), 'engine.py', 'exec'), ns)
    return ns['args']


class SkipSyncRegression(unittest.TestCase):
    def test_interactive_no_skips_shared_reader(self):
        self.assertTrue(get_prompt()([], interactive=True, prompt=lambda _: 'n'))

    def test_default_yes_runs_shared_reader(self):
        self.assertFalse(get_prompt()([], interactive=True, prompt=lambda _: ''))
        self.assertFalse(get_prompt()(['--resume'], interactive=True, prompt=lambda _: 'y'))

    def test_noninteractive_keeps_full_sync(self):
        def no_prompt(_):
            raise AssertionError('Unattended run must not prompt')
        self.assertFalse(get_prompt()(['--resume'], interactive=False, prompt=no_prompt))

    def test_explicit_flag_and_irrelevant_commands(self):
        self.assertTrue(get_prompt()(['--resume', '--skip-open-reader-sync'],
                                     interactive=False))
        self.assertFalse(get_prompt()(['--status'], interactive=True,
                                      prompt=lambda _: self.fail('status must not prompt')))

    def test_archive_only_disables_deploy_and_shutdown(self):
        state = apply_engine_skip(skip_open_reader_sync=True, deploy=True,
                                  shutdown_on_complete=True)
        self.assertFalse(state.deploy)
        self.assertFalse(state.shutdown_on_complete)

    def test_full_sync_preserves_existing_behavior(self):
        state = apply_engine_skip(skip_open_reader_sync=False, deploy=True,
                                  shutdown_on_complete=True)
        self.assertTrue(state.deploy)
        self.assertTrue(state.shutdown_on_complete)

    def test_first_prompt_precedes_existing_preflight_and_archive_safety_preserved(self):
        run = (ROOT / 'run.py').read_text(encoding='utf-8-sig')
        engine = (ROOT / 'reusable/engine.py').read_text(encoding='utf-8-sig')
        self.assertLess(run.index('scope, skip_old, run_full_tests ='),
                        run.index('    _run_preflight(run_tests=run_full_tests)'))
        self.assertIn("args = ['--resume', '--authorized']", run)
        self.assertNotIn("skip_reader_sync = (False if self_test_only", run)
        self.assertIn('def _reader_workflow_choices(', run)
        self.assertIn('skip_initial_github_check=args.skip_initial_github_check', engine)
        self.assertIn('archive_run(db, args.source_html', engine)
        self.assertIn('if args.deploy:', engine)
        self.assertIn('deployment_url = deploy_run(db, mode=args.cloudflare_mode)', engine)
        self.assertIn("a.add_argument('--skip-open-reader-sync', action='store_true'", engine)


if __name__ == '__main__':
    unittest.main()
