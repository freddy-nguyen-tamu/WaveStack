"""Prevent regression: shared Worker completion AND repeated shutdown consent."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from reusable import engine
from reusable import open_reader

spec = importlib.util.spec_from_file_location('shutdown_test_runner', ROOT / 'run.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

WORKER = 'https://open-reader.av-chatbot1.workers.dev'
SLUG = 'salty-studio'


def seed(tmp: Path, *, published=True, present=True, correct=True):
    state = tmp / '.archiver_state' / 'sites' / 'webtoon-salty-studio'
    with patch.object(engine, 'DATA', state):
        db = engine.init_db()
        engine.set_option(db, 'series_slug', SLUG)
        engine.set_option(db, 'chapter_catalog_complete', True)
        engine.set_option(db, 'chapter_catalog_total', 2)
        for i in (1, 2):
            url = WORKER + f'/comics/{SLUG}/?chapter={i}'
            db.execute('INSERT INTO chapters(chapter_id,label,url,ordinal,status,published_url) '
                       'VALUES(?,?,?,?,?,?)', (str(i),f'Ep. {i}',f'https://site.invalid/{i}',i,
                       'PUBLISHED_VERIFIED' if published else 'ARCHIVED_PENDING_DEPLOYMENT',url))
        db.commit()
    image = {'url':f'https://salty-studio-vol-001.pages.dev/chapters/001/0001.jpg',
             'width':400,'height':800,'sha256':hashlib.sha256(b'test').hexdigest()}
    chapters = [{'id':str(i),'number':str(i),'title':f'Ep. {i}', 'label':f'Ep. {i}',
                 'images':[image]} for i in (1,2)]
    registry = {'version':2,'worker_url':WORKER if correct else 'https://open-reader.wrong.workers.dev',
                'comics':{SLUG: open_reader.validate_comic(SLUG,'Salty Studio',chapters)} if present else {}}
    open_reader.state_path(tmp).parent.mkdir(parents=True,exist_ok=True)
    open_reader.state_path(tmp).write_text(json.dumps(registry),encoding='utf-8')
    return db


class ShutdownPromptRegression(unittest.TestCase):
    def test_every_interactive_plain_resume_asks_even_if_old_choice_is_no(self):
        answer=runner._shutdown_choice(['--resume','--authorized'], platform='nt',
                                       interactive=True,prompt=lambda text:'y')
        self.assertIn('--shutdown-on-complete',answer)
        answer=runner._shutdown_choice(['--resume','--authorized'], platform='nt',
                                       interactive=True,prompt=lambda text:'n')
        self.assertNotIn('--shutdown-on-complete',answer)

    def test_explicit_deploy_also_asks(self):
        answer=runner._shutdown_choice(['--deploy','--authorized'],platform='nt',interactive=True,
                                       prompt=lambda text:'yes')
        self.assertIn('--shutdown-on-complete',answer)

    def test_bypass_noninteractive_and_explicit_opt_out(self):
        never=lambda text:self.fail('Must not ask')
        self.assertNotIn('--shutdown-on-complete',runner._shutdown_choice(
            ['--deploy','--authorized'],platform='nt',interactive=False,prompt=never))
        self.assertEqual(runner._shutdown_choice(['--deploy','--authorized','--no-shutdown'],
                          platform='nt',interactive=True,prompt=never),['--deploy','--authorized'])
        self.assertIn('--shutdown-on-complete',runner._shutdown_choice(
            ['--deploy','--authorized','--shutdown-on-complete'],
            platform='nt',interactive=False,prompt=never))
        with self.assertRaises(SystemExit):
            runner._shutdown_choice(['--deploy','--authorized','--shutdown-on-complete',
                                     '--no-shutdown'],platform='nt',interactive=True,prompt=never)

    def test_verified_shared_worker_is_complete_without_legacy_pages_reader(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td)
            with patch.object(engine,'ROOT',root),patch.object(engine,'DATA',
                 root/'.archiver_state'/'sites'/'webtoon-salty-studio'):
                db=seed(root)
                self.assertTrue(engine.all_work_completed(db,mode='shared-worker',worker_url=WORKER))
                self.assertFalse(engine.all_work_completed(db,mode='pages'))
                self.assertFalse(engine.all_work_completed(db,mode='shared-worker',worker_url=None))
                db.close()

    def test_never_shutdown_if_publisher_did_not_verify_active_series(self):
        for state in ('missing','wrong','unpublished'):
            with self.subTest(state=state),tempfile.TemporaryDirectory() as td:
                root=Path(td)
                with patch.object(engine,'ROOT',root),patch.object(engine,'DATA',
                     root/'.archiver_state'/'sites'/'webtoon-salty-studio'):
                    db=seed(root,present=state!='missing',correct=state!='wrong',
                            published=state!='unpublished')
                    self.assertFalse(engine.all_work_completed(db,mode='shared-worker',worker_url=WORKER))
                    with patch.object(engine.subprocess,'run',side_effect=AssertionError('no shutdown')):
                        self.assertFalse(engine.request_windows_shutdown_after_completion(
                            db,mode='shared-worker',worker_url=WORKER))
                    db.close()

    def test_verified_noop_publish_triggers_shutdown_after_success(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td)
            data=root/'.archiver_state'/'sites'/'webtoon-salty-studio'
            with patch.object(engine,'ROOT',root),patch.object(engine,'DATA',data):
                db=seed(root)
                db.close()
                with patch.object(engine,'_inherit_shared_github_auth'), \
                     patch.object(engine,'deploy_run',return_value=WORKER) as deploy, \
                     patch('reusable.title_reconcile.reconcile_native_titles'), \
                     patch.object(engine,'request_windows_shutdown_after_completion',
                                  return_value=True) as shutdown, \
                     patch.object(engine,'status'), \
                     patch.object(sys,'argv',['comic_archiver.py','--deploy','--authorized',
                                            '--shutdown-on-complete']):
                    engine.main()
                deploy.assert_called_once()
                self.assertEqual(shutdown.call_count,1)
                self.assertEqual(shutdown.call_args.kwargs,
                                 {'mode':'shared-worker','worker_url':WORKER})

    def test_no_shutdown_on_failed_publish_even_if_flag_set(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td); data=root/'.archiver_state'/'sites'/'webtoon-salty-studio'
            with patch.object(engine,'ROOT',root),patch.object(engine,'DATA',data):
                db=seed(root);db.close()
                with patch.object(engine,'_inherit_shared_github_auth'), \
                     patch.object(engine,'deploy_run',side_effect=RuntimeError('worker not reachable')), \
                     patch('reusable.title_reconcile.reconcile_native_titles'), \
                     patch.object(engine,'request_windows_shutdown_after_completion') as shutdown, \
                     patch.object(engine,'status'), \
                     patch.object(sys,'argv',['comic_archiver.py','--deploy','--authorized',
                                            '--shutdown-on-complete']):
                    with self.assertRaisesRegex(RuntimeError,'worker not reachable'):
                        engine.main()
                shutdown.assert_not_called()

    def test_actual_shutdown_command_only_after_verified_shared_worker(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td); data=root/'.archiver_state'/'sites'/'webtoon-salty-studio'
            with patch.object(engine,'ROOT',root),patch.object(engine,'DATA',data):
                db=seed(root)
                with patch.object(engine,'os',SimpleNamespace(name='nt')), \
                     patch.object(engine.subprocess,'run',return_value=SimpleNamespace(returncode=0)) as cmd:
                    self.assertTrue(engine.request_windows_shutdown_after_completion(
                        db,mode='shared-worker',worker_url=WORKER))
                cmd.assert_called_once()
                self.assertEqual(cmd.call_args.args[0][:4],['shutdown.exe','/s','/t','60'])
                db.close()

if __name__=='__main__':
    unittest.main()
