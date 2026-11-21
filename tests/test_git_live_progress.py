"""End-to-end tests for live Git metadata telemetry and immutable-tip fast path."""
import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import comic_archiver as engine
from reusable import archive_inventory


class GitLiveProgressTests(unittest.TestCase):
    def test_child_emits_real_git_transfer_stats_not_just_spinner(self):
        script = ("import sys,time; "
                  "sys.stderr.write('remote: Counting objects: 100% (4/4)\\r');sys.stderr.flush();"
                  "sys.stderr.write('Receiving objects: 50% (2/4), 1.00 MiB | 2.00 MiB/s\\r');"
                  "sys.stderr.flush();time.sleep(.10);"
                  "sys.stderr.write('Receiving objects: 100% (4/4), 2.00 MiB | 2.00 MiB/s\\r');"
                  "sys.stderr.write('Resolving deltas: 100% (1/1), done.\\n');"
                  "sys.stderr.flush();sys.stdout.write('SUCCESS')")
        out = io.StringIO()
        with tempfile.TemporaryDirectory() as td, contextlib.redirect_stdout(out):
            proc = archive_inventory._git_with_live_progress(
                [sys.executable, '-u', '-c', script], Path(td), dict(os.environ),
                'GitHub archive metadata: test-vol-001')
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, b'SUCCESS')
        self.assertIn(b'Receiving objects: 50%', proc.stderr)
        text = out.getvalue()
        self.assertIn('Receiving objects',text)
        self.assertIn('2/4 objects',text)
        self.assertIn('1.00 MiB at 2.00 MiB/s',text)
        self.assertIn('Git metadata fetched successfully',text)

    def test_never_echo_arbitrary_git_stderr_containing_secret(self):
        script = "import sys;sys.stderr.write('fatal: password=SECRET123 fake-url\\n');sys.exit(12)"
        out=io.StringIO()
        with tempfile.TemporaryDirectory() as td, contextlib.redirect_stdout(out):
            proc=archive_inventory._git_with_live_progress(
                [sys.executable,'-u','-c',script],Path(td),dict(os.environ),'Fetch test')
        self.assertEqual(proc.returncode,12)
        self.assertNotIn('SECRET123',out.getvalue())
        self.assertIn('FAILED',out.getvalue().upper())

    def test_fetch_command_enables_progress_with_pipe(self):
        fake=subprocess.CompletedProcess(['git','fetch'],0,b'',b'')
        with patch.object(archive_inventory,'_git_with_live_progress',return_value=fake) as show:
            result=archive_inventory._git(Path('.'),dict(os.environ),'fetch','--depth=1',
                                          'origin','main',progress_label='Fetch test')
        self.assertEqual(result,'')
        self.assertIn('--progress',show.call_args.args[0])
        self.assertEqual(show.call_args.args[0][:2],['git','fetch'])

    def test_verified_commit_skips_repeat_packfile_download(self):
        from tests.test_resume_inventory import manifest
        m=manifest('1')
        with tempfile.TemporaryDirectory() as td, patch.object(engine,'DATA',Path(td)):
            db=engine.init_db()
            engine.set_option(db,'github_owner','testuser')
            engine.set_option(db,'series_slug','series')
            engine.set_option(db,'chapter_catalog_complete',True)
            engine.set_option(db,'chapter_catalog_total',1)
            record=lambda tip: [dict(chapter_id='1',manifest=m,repository='series-vol-001',
                                     tip_sha=tip,previously_verified=True)]
            with patch.object(engine,'credential_for_selected',return_value=('testuser','dummy')), \
                 patch.object(engine,'_existing_github_volumes',return_value=['series-vol-001']), \
                 patch.object(archive_inventory,'read_remote_chapters',return_value=record('a'*40)) as full, \
                 patch.object(archive_inventory,'remote_tip',return_value='a'*40) as tip, \
                 patch.object(engine.ADAPTER,'ARCHIVED_SOURCE_CHAPTER_COUNT',1):
                first=engine.reconcile_github_archive(db)
                self.assertEqual(first['recovered'],1)
                self.assertEqual(full.call_count,1)
                second=engine.reconcile_github_archive(db)
                self.assertEqual(second['recovered'],0)
                self.assertEqual(full.call_count,1,'second run must not download packfile')
                self.assertEqual(tip.call_count,1)
                # A remote changed commit forces full reinspection.
                tip.return_value='b'*40
                full.return_value=record('b'*40)
                engine.reconcile_github_archive(db)
                self.assertEqual(full.call_count,2)
                # A local changed manifest also forces a reinspection even with same tip.
                db.execute("UPDATE chapters SET pages_json=? WHERE chapter_id='1'",
                           (json.dumps({**m,'chapter_title':'changed locally'}),))
                db.commit()
                engine.reconcile_github_archive(db)
                self.assertEqual(full.call_count,3)
            db.close()


if __name__=='__main__':
    unittest.main()
