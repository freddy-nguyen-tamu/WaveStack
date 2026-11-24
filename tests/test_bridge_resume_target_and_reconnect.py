"""Generic resume target and bounded transport recovery regressions."""
import json
import sqlite3
import unittest
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch
from reusable import engine
from reusable.browser_bridge import LocalBridge, BrowserBridgeError, BRIDGE_PROTOCOL


SEED='https://reader.example.test/comic/sample/chapter-00/'
TARGET='https://reader.example.test/comic/sample/chapter-18/'


class ResumeHandshakeTests(unittest.TestCase):
    def test_first_hello_rejects_old_seed_and_accepts_resume_target(self):
        b=LocalBridge(SEED, initial_chapter_url=TARGET, port=0, require_managed_tab=True)
        b.start()
        self.addCleanup(b.close)
        def hello(url):
            msg={'url':url, 'bridge_protocol':BRIDGE_PROTOCOL,
                 'capabilities':['probe','image','content-v2'],
                 'tab_ownership':'extension-managed', 'tab_id':123,
                 'tab_title':'Example chapter'}
            req=Request(f'http://127.0.0.1:{b.port}/hello',data=json.dumps(msg).encode(),
                        headers={'Content-Type':'application/json',
                                 'Origin':'chrome-extension://abcd1234',
                                 'X-Comic-Bridge-Client':'abcd1234abcd1234',
                                 'X-Comic-Bridge-Token':b.secret},method='POST')
            try:
                with urlopen(req,timeout=5) as res:
                    return res.status,json.load(res)
            except HTTPError as exc:
                return exc.code,json.load(exc)
        status,response=hello(SEED)
        self.assertEqual(status,409)
        self.assertFalse(b.ready.is_set())
        self.assertIn('BROWSER_RESUME_TARGET_NOT_READY',response['error'])
        status,_=hello(TARGET)
        self.assertEqual(status,200)
        self.assertTrue(b.ready.is_set())
        self.assertEqual(b.tab_url,TARGET)
        # Later /hello notifications are allowed for legitimate chapter
        # navigation and tab recycling, not pinned to the first resume target.
        self.assertEqual(hello(SEED)[0],200)

    def test_generic_extension_waits_for_requested_startup_document(self):
        from pathlib import Path
        path=Path(__file__).resolve().parents[1]/'reusable/browser_bridge_extension/background.js'
        script=path.read_text(encoding='utf-8')
        self.assertIn('waitContent(20000,expectedResumeUrl || tab.url)',script)
        self.assertIn('canonicalPage(readyTab.url)!==canonicalPage(expectedResumeUrl)',script)
        self.assertIn("await api('/hello',{url:readyTab.url",script)

    def test_normal_seed_binding_and_human_window_unchanged(self):
        b=LocalBridge(SEED, initial_chapter_url=SEED, port=0, require_managed_tab=True)
        self.assertIsNone(b.server)
        self.assertFalse(b.ready.is_set())
        self.assertEqual(b.initial_chapter_url, SEED)

    def test_resume_candidates_keep_verified_and_ordered(self):
        db=sqlite3.connect(':memory:')
        self.addCleanup(db.close)
        db.execute('CREATE TABLE chapters (chapter_id TEXT PRIMARY KEY,status TEXT)')
        catalog=[SimpleNamespace(chapter_id=f'ch-{i}',url=SEED if i==0 else
             f'https://reader.example.test/comic/sample/chapter-{i}/') for i in range(31)]
        db.executemany('INSERT INTO chapters VALUES (?,?)',[(f'ch-{i}',
           'ARCHIVED_PENDING_DEPLOYMENT' if i<18 else 'DISCOVERED') for i in range(31)])
        rem=engine._source_resume_candidates(db,catalog)
        self.assertEqual(len(rem),13)
        self.assertEqual(rem[0].chapter_id,'ch-18')


class BoundedReconnectTests(unittest.TestCase):
    def call(self, side_effect, browser='extension'):
        with patch.object(engine,'_archive_run_once',side_effect=side_effect) as run, \
             patch.object(engine,'event') as event,patch.object(engine.time,'sleep') as sleep:
            def invoke():
                return engine.archive_run(object(),None,SEED,100,True,
                    source_browser=browser,skip_initial_github_check=True)
            return invoke,run,event,sleep

    def test_heartbeat_loss_retries_from_db_without_old_remote_audit(self):
        failure=BrowserBridgeError('Comic Bridge stopped responding during scroll (no heartbeat)')
        seen=[]
        def run_once(*args,**kwargs):
            seen.append(engine._BRIDGE_RECOVERY_PAIR_TIMEOUT.get())
            if len(seen)==1:raise failure
            return 'completed'
        with patch.object(engine,'_archive_run_once',side_effect=run_once) as run, \
             patch.object(engine,'event') as events,patch.object(engine.time,'sleep'):
            result=engine.archive_run(object(),None,SEED,100,True,
                   source_browser='extension',skip_initial_github_check=False)
        self.assertEqual(result,'completed')
        self.assertEqual(run.call_count,2)
        self.assertEqual(seen,[None,90])
        self.assertIsNone(engine._BRIDGE_RECOVERY_PAIR_TIMEOUT.get())
        self.assertFalse(run.call_args_list[0].kwargs['skip_remote_reconcile'])
        self.assertTrue(run.call_args_list[1].kwargs['skip_remote_reconcile'])
        self.assertTrue(any(call.args[0]=='BROWSER_BRIDGE_AUTO_RECONNECT' for call in events.call_args_list))

    def test_retries_are_bounded_and_fail_closed(self):
        fail=BrowserBridgeError('Comic Bridge stopped responding during scroll (no heartbeat)')
        with patch.object(engine,'_archive_run_once',side_effect=fail) as run, \
             patch.object(engine,'event'),patch.object(engine.time,'sleep'):
            with self.assertRaisesRegex(BrowserBridgeError,'BROWSER_BRIDGE_RECONNECT_EXHAUSTED'):
                engine.archive_run(object(),None,SEED,100,True,source_browser='extension')
        self.assertEqual(run.call_count,3)

    def test_other_browser_and_nonheartbeat_failures_are_never_retried(self):
        for browser,error in [('extension','CAPTCHA verification required'),
                              ('firefox','Comic Bridge stopped responding during scroll (no heartbeat)'),
                              ('extension','Browser navigate failed: cross-site navigation refused')]:
            with self.subTest(browser=browser,error=error):
                with patch.object(engine,'_archive_run_once',side_effect=BrowserBridgeError(error)) as run, \
                     patch.object(engine,'event'),patch.object(engine.time,'sleep'):
                    with self.assertRaises(BrowserBridgeError):
                        engine.archive_run(object(),None,SEED,100,True,source_browser=browser)
                self.assertEqual(run.call_count,1)

if __name__=='__main__':unittest.main()
