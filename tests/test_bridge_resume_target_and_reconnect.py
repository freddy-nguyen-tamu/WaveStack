"""Generic resume target and bounded transport recovery regressions."""
import json
import sqlite3
import unittest
from types import SimpleNamespace
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch
from reusable import engine
from reusable.browser_bridge import (LocalBridge, BrowserBridgeError, BrowserTransportUnavailable,
                                     _bridge_rpc_error, bridge_recovery_reason, BRIDGE_PROTOCOL)


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

    def test_stale_handshake_can_repair_without_second_run(self):
        import threading
        import time
        b=LocalBridge(SEED, initial_chapter_url=SEED, port=0, require_managed_tab=True)
        b.require_startup_refresh=True
        b.start()
        self.addCleanup(b.close)
        def hello(revision):
            payload={'url':SEED,'bridge_protocol':BRIDGE_PROTOCOL,
                     'capabilities':['probe','image','content-v2'],
                     'tab_ownership':'extension-managed','tab_id':7,
                     'startup_refresh_revision':revision}
            req=Request(f'http://127.0.0.1:{b.port}/hello',
                        data=json.dumps(payload).encode(),method='POST',headers={
                            'Content-Type':'application/json',
                            'Origin':'chrome-extension://abcdef12',
                            'X-Comic-Bridge-Client':'abcdef123456abcd',
                            'X-Comic-Bridge-Token':b.secret})
            try:
                with urlopen(req,timeout=5) as response:
                    return response.status
            except HTTPError as exc:
                return exc.code
        self.assertEqual(hello(None),409)
        result=[]
        t=threading.Thread(target=lambda:result.append(b.wait_paired(timeout_seconds=5)),daemon=True)
        t.start()
        time.sleep(0.08)
        self.assertTrue(t.is_alive())
        self.assertEqual(hello(1),200)
        t.join(timeout=2)
        self.assertFalse(t.is_alive())
        self.assertEqual(result,[None])
        self.assertFalse(b.outdated_client.is_set())

    def test_scroll_acknowledgement_not_faked_by_ping(self):
        # Required startup gate also exercises the real extension JS protocol.
        # This fails on the old PING-only same-tab workaround.
        import shutil
        import subprocess
        from pathlib import Path
        node=shutil.which('node')
        test=Path(__file__).resolve().parent/'extension_scroll_receipt_recovery.js'
        self.assertTrue(test.is_file(),'mandatory scroll receipt regression missing')
        if not node:
            self.skipTest('Node.js not installed; Python-first dependency bootstrap')
        check=subprocess.run([node,str(test)],cwd=test.parent.parent,
                             capture_output=True,text=True,timeout=12)
        self.assertEqual(check.returncode,0,check.stdout+'\n'+check.stderr)

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

class LiveFailureRegressions(unittest.TestCase):
    def test_actual_browser_errors_are_typed_at_rpc_boundary(self):
        for action, error in (
                ('scroll','Error: SCROLL_NOT_READY: current chapter tab is not ready'),
                ('recover_image','Error: Selected-tab browser API stalled: recover_image existing-listener fallback'),
                ('image','Error: Selected-tab browser API stalled: position image tile')):
            with self.subTest(action=action):
                b=LocalBridge(SEED,port=0)
                b.ready.set()
                def deliver(job):
                    b.responses[job['id']].put({'ok':False,'error':error})
                with patch.object(b.pending,'put',side_effect=deliver):
                    with self.assertRaises(BrowserTransportUnavailable):
                        b.rpc(action)
                self.assertFalse(b.responses)

    def test_transient_source_and_uncertain_scroll_errors_not_reconnected(self):
        for message in ('Browser image failed: HTTP 403',
                        'Browser image failed: image not visibly decoded',
                        'Browser scroll failed: SCROLL_OUTCOME_UNKNOWN: command may have executed',
                        'Browser scroll failed: SCROLL_DOCUMENT_CHANGED: refusing stale receipt',
                        'Browser navigate failed: Cross-site navigation refused'):
            error=_bridge_rpc_error(message)
            self.assertIsNone(bridge_recovery_reason(error))
            self.assertNotIsInstance(error,BrowserTransportUnavailable)

    def test_readiness_and_api_stall_retry_with_fresh_budget_for_later_chapter(self):
        def failed(chapter, message):
            exc=_bridge_rpc_error(message)
            exc.recovery_chapter_id=chapter
            return exc
        scroll='Browser scroll failed: Error: SCROLL_NOT_READY: current chapter tab is not ready'
        stall='Browser recover_image failed: Error: Selected-tab browser API stalled: recover_image existing-listener fallback'
        failures=[failed('203',scroll),failed('203',stall),failed('211',scroll),'completed']
        with patch.object(engine,'_archive_run_once',side_effect=failures) as run, \
             patch.object(engine,'event') as events,patch.object(engine.time,'sleep'):
            result=engine.archive_run(object(),None,SEED,100,True,source_browser='extension')
        self.assertEqual(result,'completed')
        self.assertEqual(run.call_count,4)
        recovery=[c.kwargs for c in events.call_args_list if c.args[0]=='BROWSER_BRIDGE_AUTO_RECONNECT']
        self.assertEqual([(r['chapter'],r['attempt']) for r in recovery],[('203',1),('203',2),('211',1)])
        self.assertEqual([c.kwargs['skip_remote_reconcile'] for c in run.call_args_list],[False,True,True,True])

    def test_image_transfer_stall_not_retried_as_individual_image(self):
        import tempfile
        from pathlib import Path
        from unittest.mock import Mock
        failure=_bridge_rpc_error('Browser image failed: Error: Selected-tab browser API stalled: capture selected-tab pixels')
        req=SimpleNamespace(reuses_loaded_page_images=True,get=Mock(side_effect=failure))
        with tempfile.TemporaryDirectory() as directory, patch.object(engine.time,'sleep') as sleep:
            with self.assertRaises(BrowserTransportUnavailable):
                engine.image_download(SimpleNamespace(request=req),'https://cdn.example.test/1.png',
                    Path(directory)/'0001',SEED,max_tries=4)
        req.get.assert_called_once()
        sleep.assert_not_called()

    def test_recover_image_stall_exits_scanner_without_per_image_retry(self):
        from test_streaming_order import SimPage, Tests
        page=SimPage(late=True)
        saved,_,callback=Tests().callback(page)
        attempts=[]
        def recover(key,url,**kwargs):
            attempts.append(key)
            raise _bridge_rpc_error('Browser recover_image failed: Error: Selected-tab browser API stalled: recover_image existing-listener fallback')
        page.recover_unloaded_image=recover
        adapter=SimpleNamespace(READER_SELECTORS=['main'],IMAGE_ATTRIBUTES=['src'],custom_page_snapshot=None)
        with patch.object(engine,'ADAPTER',adapter),patch.object(engine,'classify_browser_page',return_value=None),patch.object(engine,'event'):
            with self.assertRaises(BrowserTransportUnavailable):
                engine.scan_browser_images(page,max_steps=30,stability=2,on_progress=callback)
        self.assertEqual(attempts,['2'])
        self.assertEqual(set(saved),{'1'})

if __name__=='__main__':unittest.main()
