"""Process supervisor: unexpected exceptions must not end unattended archiving."""
import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import run


class ArchiveSupervisorTests(unittest.TestCase):
    def run_codes(self, codes):
        seen, delays = [], []
        values = iter(codes)
        def call(cmd, cwd):
            seen.append(cmd)
            return next(values)
        with contextlib.redirect_stdout(io.StringIO()):
            run._run_archive_retry_loop(['--resume', '--authorized', '--shutdown-on-complete'], call=call, sleep=delays.append)
        return seen, delays

    def test_unknown_and_known_failures_restart(self):
        seen, delays = self.run_codes([1, 75, 9, -11, 1, 1, 0])
        self.assertEqual(len(seen), 7)
        self.assertEqual(delays, [5,10,20,40,60,60])
        for cmd in seen[1:]:
            self.assertIn('--skip-initial-github-check', cmd)
            self.assertIn('--shutdown-on-complete', cmd)
            self.assertIn('--authorized', cmd)
            self.assertEqual(cmd.count('--skip-initial-github-check'), 1)

    def test_explicit_stop_does_not_restart(self):
        for code in (130, -2, -1073741510, 3221225786):
            with self.subTest(code=code), contextlib.redirect_stdout(io.StringIO()):
                calls, delays = [], []
                def call(cmd, cwd):
                    calls.append(cmd)
                    return code
                with self.assertRaises(SystemExit) as cm:
                    run._run_archive_retry_loop(['--resume'], call=call, sleep=delays.append)
                self.assertEqual(cm.exception.code, 130)
                self.assertEqual(len(calls), 1)
                self.assertEqual(delays, [])

    def test_usage_and_source_pause_also_restart(self):
        seen, delays = self.run_codes([2, 76, 2, 76, 0])
        self.assertEqual(len(seen), 5)
        self.assertEqual(delays, [5, 300, 20, 300])

    def test_all_nonzero_exit_codes_except_interrupt_restart(self):
        codes = [i for i in range(1, 256) if i not in run._RETRY_INTERRUPT_CODES]
        seen, delays = self.run_codes([*codes, 0])
        self.assertEqual(len(seen), len(codes) + 1)
        self.assertEqual(len(delays), len(codes))

    def test_ctrl_c_during_wait(self):
        def stop(_): raise KeyboardInterrupt
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(SystemExit) as cm:
            run._run_archive_retry_loop(['--resume'], call=lambda *a, **k: 1, sleep=stop)
        self.assertEqual(cm.exception.code, 130)

    def test_launch_error_retries(self):
        calls, delays = [], []
        def call(cmd, cwd):
            calls.append(cmd)
            if len(calls) == 1: raise OSError('temporary launch failure')
            return 0
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            run._run_archive_retry_loop(['--resume'], call=call, sleep=delays.append)
        self.assertEqual(len(calls), 2)
        self.assertEqual(delays, [5])

    def test_real_child_process_unhandled_exception_restarts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root/'run.py').write_text('''from pathlib import Path
import sys
p = Path(__file__).with_name('attempts')
n = int(p.read_text()) if p.exists() else 0
p.write_text(str(n+1))
if n == 0: raise RuntimeError('ordinary unclassified failure')
if n == 1: sys.exit(2)
if n == 2: sys.exit(76)
assert '--skip-initial-github-check' in sys.argv
assert '--authorized' in sys.argv
''', encoding='utf-8')
            delays = []
            with patch.object(run, 'ROOT', root), contextlib.redirect_stdout(io.StringIO()):
                run._run_archive_retry_loop(['--resume','--authorized'], sleep=delays.append)
            self.assertEqual((root/'attempts').read_text(), '4')
            self.assertEqual(delays, [5,10,300])

    def test_real_launcher_without_optional_exception_class(self):
        import os
        import subprocess
        import sys
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root/'run.py').write_bytes(Path(run.__file__).read_bytes())
            package = root/'reusable'
            package.mkdir()
            (package/'__init__.py').write_text('')
            # Deliberately model the user's installed chapter_script revision.
            (package/'chapter_script.py').write_text('def enabled(adapter): return False\n')
            (package/'engine.py').write_text("""from pathlib import Path
import sys
from . import chapter_script
def main():
    p = Path(__file__).parent.parent / 'attempts'
    n = int(p.read_text()) if p.exists() else 0
    p.write_text(str(n+1))
    assert '--resume' in sys.argv
    assert '--authorized' in sys.argv
    assert '--shutdown-on-complete' in sys.argv
    if n == 0: raise RuntimeError('ordinary resource failure')
    assert '--skip-initial-github-check' in sys.argv
""", encoding='utf-8')
            delays = []
            env = dict(os.environ, COMIC_ARCHIVER_IN_VENV='1')
            outputs = []
            def call(cmd, cwd):
                r = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True, timeout=15)
                outputs.append(r)
                if len(outputs) > 2: self.fail('Actual launcher failed to reach success')
                return r.returncode
            with patch.object(run, 'ROOT', root), contextlib.redirect_stdout(io.StringIO()):
                run._run_archive_retry_loop(['--resume','--authorized','--shutdown-on-complete'], call=call, sleep=delays.append)
            self.assertEqual((root/'attempts').read_text(), '2')
            self.assertEqual([r.returncode for r in outputs], [1, 0])
            self.assertIn('ordinary resource failure', outputs[0].stderr)
            self.assertNotIn('ImportError', outputs[0].stderr)
            self.assertEqual(delays, [5])

    def test_maintenance_excluded(self):
        self.assertTrue(run._archive_retry_enabled(['--resume'], 'comic'))
        for args, scope in ((['--status'],'comic'),(['--resume','--max-chapters','1'],'comic'),(['--resume'],'site')):
            self.assertFalse(run._archive_retry_enabled(args,scope))
