"""A stale startup handshake must not poison a later valid extension pairing."""
import json
import time
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from reusable.browser_bridge import LocalBridge, BrowserBridgeError, BRIDGE_PROTOCOL

SITE='https://reader.example.test/comic/chapter-5/'
class StartupHandshakeGrace(unittest.TestCase):
    def setUp(self):
        self.bridge=LocalBridge(SITE,port=0,require_managed_tab=True)
        self.bridge.require_startup_refresh=True
        self.bridge.start()
        self.addCleanup(self.bridge.close)
    def hello(self, revision):
        payload={'url':SITE,'bridge_protocol':BRIDGE_PROTOCOL,
                 'capabilities':['probe','image','content-v2'],
                 'startup_refresh_revision':revision,
                 'tab_ownership':'extension-managed','tab_id':7,'tab_title':'Chapter 5'}
        req=Request(f'http://127.0.0.1:{self.bridge.port}/hello',
                    data=json.dumps(payload).encode(),method='POST',headers={
                      'Origin':'chrome-extension://abcdef12',
                      'X-Comic-Bridge-Client':'abcdef123456abcd',
                      'X-Comic-Bridge-Token':self.bridge.secret,
                      'Content-Type':'application/json'})
        try:
            with urlopen(req,timeout=5) as resp:
                return resp.status,json.load(resp)
        except HTTPError as exc:
            return exc.code,json.load(exc)
    def test_invalid_before_valid_is_recovered_in_same_python_session(self):
        self.assertEqual(self.hello(None)[0],409)
        self.assertFalse(self.bridge.ready.is_set())
        outcome=[]
        t=threading.Thread(target=lambda: outcome.append(self.bridge.wait_paired(timeout_seconds=8)),daemon=True)
        t.start()
        time.sleep(.08)
        self.assertTrue(t.is_alive(),'one invalid /hello must not terminate wait_paired')
        self.assertEqual(self.hello(1)[0],200)
        t.join(timeout=3)
        self.assertFalse(t.is_alive())
        self.assertTrue(self.bridge.ready.is_set())
        self.assertFalse(self.bridge.outdated_client.is_set())
        self.assertEqual(outcome,[None])
    def test_persistently_incompatible_fails_with_actual_reason(self):
        self.assertEqual(self.hello(None)[0],409)
        self.bridge.outdated_first_seen=time.monotonic()-26
        with self.assertRaisesRegex(BrowserBridgeError, 'Missing startup_refresh_revision'):
            self.bridge.wait_paired(timeout_seconds=8)
        self.assertFalse(self.bridge.ready.is_set())

if __name__=='__main__': unittest.main()
