"""Regression tests: observable deployment progress and strictly opt-in shutdown."""
from __future__ import annotations
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import comic_archiver as engine
from reusable.progress import Progress


def git(directory, *args):
    p = subprocess.run(['git',*args],cwd=directory,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if p.returncode:
        raise RuntimeError(p.stderr.decode(errors='replace'))
    return p.stdout.decode(errors='replace').strip()


class ProgressShutdownTests(unittest.TestCase):
    def test_progress_bar_has_real_file_fraction(self):
        out=io.StringIO()
        clock=[0.0]
        bar=Progress('Building Cloudflare assets',total=10,unit='images',
                     clock=lambda:clock[0],output=out,interval=0)
        clock[0]=1.0
        bar.update(5,'2 MiB staged')
        clock[0]=2.0
        bar.complete('verified')
        text=out.getvalue()
        self.assertIn('50.0%',text)
        self.assertIn('100.0%',text)
        self.assertIn('5/10 images',text)
        self.assertIn('DONE',text)

    def test_unknown_duration_never_fakes_percent(self):
        out=io.StringIO()
        bar=Progress('Wrangler deploy',output=out,interval=0)
        bar.heartbeat(force=True)
        self.assertIn('completion % unavailable',out.getvalue())
        self.assertNotIn('100.0%',out.getvalue())

    def test_monitored_child_streams_unicode_and_reports_completion(self):
        env=os.environ.copy()
        with tempfile.TemporaryDirectory() as td:
            captured=io.StringIO()
            with patch('sys.stdout',captured):
                p=engine._run_monitored_command(
                    [sys.executable,'-c', 'import sys,time;print("Upload ✅",flush=True);'
                     'sys.stderr.write("Receiving objects: 50%\\n");time.sleep(.1)'],
                    cwd=td,env=env,label='Cloudflare test',show_provider_lines=True)
            self.assertEqual(p.returncode,0)
            self.assertIn('Upload ✅',p.stdout)
            self.assertIn('Receiving objects: 50%',p.stderr)
            self.assertIn('command exited successfully',captured.getvalue())

    def test_complete_catalog_required_before_shutdown(self):
        with tempfile.TemporaryDirectory() as td,patch.object(engine,'DATA',Path(td)):
            db=engine.init_db()
            engine.set_option(db,'series_slug','series')
            db.execute('INSERT INTO chapters(chapter_id,label,url,ordinal,status) VALUES(?,?,?,?,?)',
                       ('1','chapter','https://example.invalid',0,'ARCHIVED_PENDING_DEPLOYMENT'))
            db.commit()
            self.assertFalse(engine.all_work_completed(db))
            with patch.object(engine.subprocess,'run',side_effect=AssertionError('must not shutdown')):
                self.assertFalse(engine.request_windows_shutdown_after_completion(db))
            db.close()

    def test_only_explicit_shutdown_on_verified_full_publication(self):
        with tempfile.TemporaryDirectory() as td,patch.object(engine,'DATA',Path(td)):
            db=engine.init_db()
            engine.set_option(db,'series_slug','series')
            engine.set_option(db,'chapter_catalog_complete',True)
            engine.set_option(db,'chapter_catalog_total',1)
            db.execute('INSERT INTO chapters(chapter_id,label,url,ordinal,status,published_url) VALUES(?,?,?,?,?,?)',
                       ('1','Episode 1','https://example.invalid/1',0,'PUBLISHED_VERIFIED',
                        'https://series-reader.pages.dev/?chapter=1'))
            db.execute('INSERT INTO deployments(project,production_url) VALUES(?,?)',
                       ('series-reader','https://series-reader.pages.dev'))
            db.commit()
            self.assertTrue(engine.all_work_completed(db))
            with patch.object(engine,'os',SimpleNamespace(name='nt')), \
                 patch.object(engine.subprocess,'run',return_value=SimpleNamespace(returncode=0)) as run:
                self.assertTrue(engine.request_windows_shutdown_after_completion(db,60))
            run.assert_called_once()
            self.assertEqual(run.call_args.args[0][:4], ['shutdown.exe','/s','/t','60'])
            self.assertIn('WINDOWS_SHUTDOWN_SCHEDULED',
                          (Path(td)/'events.jsonl').read_text())
            db.close()

    def test_git_volume_fetched_and_checked_out_once_for_all_images(self):
        with tempfile.TemporaryDirectory() as td,patch.object(engine,'DATA',Path(td)/'state'):
            root=Path(td); bare=root/'repo.git'; original=root/'original'
            git(root,'init','--bare',str(bare))
            original.mkdir();git(original,'init','-b','main')
            git(original,'config','user.email','test@example.invalid')
            git(original,'config','user.name','Test')
            entries=[]; paths=[]
            for i in range(7):
                relative=f'chapters/001/{i+1:04d}.png'
                content=b'fake image '+str(i).encode()
                path=original/relative
                path.parent.mkdir(exist_ok=True,parents=True)
                path.write_bytes(content)
                entries.append(dict(sha256=hashlib.sha256(content).hexdigest(),
                                    bytes=len(content)))
                paths.append(relative)
            git(original,'add','.');git(original,'commit','-m','archive')
            git(original,'remote','add','origin',str(bare));git(original,'push','origin','main')
            db=engine.init_db()
            row=dict(repository='series-vol-001',pages_json=json.dumps(dict(images=entries,remote_files=paths)))
            target=root/'cloudflare';target.mkdir()
            with patch.object(engine,'isolated_git_environment',return_value=os.environ.copy()), \
                 patch.object(engine,'_run_monitored_command', wraps=engine._run_monitored_command) as runner:
                result=engine._fetch_verified_files(db,[row],target,'local-test',remote_url=str(bare))
            self.assertEqual(len(result),7)
            self.assertEqual(runner.call_count,1)  # one fetch, never 7 lazy pulls
            self.assertTrue(all(p.is_file() for p,_,_ in result))
            self.assertEqual({p.name for p,_,_ in result},{f'{i+1:04d}.png' for i in range(7)})
            db.close()

    def test_setup_prompts_for_shutdown_and_flags_are_supported(self):
        root=Path(__file__).resolve().parents[1]
        bootstrap=(root/'setup_and_publish.ps1').read_text(encoding='utf-8')
        self.assertIn('ShutdownWhenDone',bootstrap)
        self.assertIn('shutdown-on-complete',bootstrap)
        args=engine.build_parser().parse_args(['--deploy','--authorized','--shutdown-on-complete'])
        self.assertTrue(args.shutdown_on_complete)

if __name__=='__main__':
    unittest.main()
