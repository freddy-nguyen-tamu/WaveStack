import json
import threading
import unittest
import urllib.request
from unittest.mock import patch
import run
from reusable.browser_bridge import LocalBridge

class RetryEmptyWindowCleanupTests(unittest.TestCase):
    def test_cleanup_only_bootstrap_and_ack(self):
        bridge=LocalBridge('https://example.com/chapter/1/',port=0)
        bridge.cleanup_only=True
        bridge.start()
        try:
            base=f'http://127.0.0.1:{bridge.port}'
            headers={'X-Comic-Bridge-Bootstrap':'1','X-Comic-Bridge-Client':'test-extension'}
            with urllib.request.urlopen(urllib.request.Request(base+'/bootstrap',headers=headers)) as response:
                config=json.load(response)
            self.assertEqual(config['protocol'],'cleanup-empty-windows-1')
            self.assertNotIn('startup_url',config)
            headers.update({'X-Comic-Bridge-Token':config['token'],'Content-Type':'application/json'})
            receipt={'closed':2,'remaining':0}
            with urllib.request.urlopen(urllib.request.Request(base+'/retry-window-cleanup',data=json.dumps(receipt).encode(),headers=headers)) as response:
                self.assertEqual(json.load(response),{'ok':True})
            self.assertTrue(bridge.ready.wait(1))
            self.assertEqual(bridge.cleanup_receipt,receipt)
        finally:
            bridge.close()

    def test_cleanup_before_each_failed_child_restart(self):
        events=[]
        codes=iter([1,2,0])
        def child(*args,**kw):
            events.append('child');return next(codes)
        with patch.object(run,'_close_empty_browser_windows_before_retry',side_effect=lambda:events.append('cleanup')):
            run._run_archive_retry_loop(['--resume'],call=child,sleep=lambda _:events.append('delay'))
        self.assertEqual(events,['child','cleanup','delay','child','cleanup','delay','child'])

if __name__=='__main__':unittest.main()
