import base64
import contextlib
import hashlib
import io
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from PIL import Image
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from reusable import browser_bridge as bridge
from site_specific import site_adapter as adapter

class VisualTransferProof(unittest.TestCase):
    def test_actual_loopback_image_data_has_provenance(self):
        image=Image.new('RGB',(32,24),(11,23,31));buf=io.BytesIO();image.save(buf,format='PNG');raw=buf.getvalue()
        with tempfile.TemporaryDirectory() as td:
            def fake_start(_):pass
            def fake_wait(_):pass
            def fake_close(_):pass
            def fake_rpc(self,action,payload=None,timeout=120):
                self.test_case_actions.append(action)
                if action=='probe':return {'status':200,'base64':base64.b64encode(raw).decode(),'via':'rendered-png'}
                if action=='image':return {'status':200,'url':payload['url'],'base64':base64.b64encode(raw).decode(),'via':'rendered-png'}
            bridge.LocalBridge.test_case_actions=[]
            with patch.object(bridge,'ensure_generated_extensions'),patch.object(bridge.LocalBridge,'start',fake_start),\
                 patch.object(bridge.LocalBridge,'wait_paired',fake_wait),patch.object(bridge.LocalBridge,'close',fake_close),\
                 patch.object(bridge.LocalBridge,'rpc',fake_rpc):
                with bridge.source_extension_context(Path(td),adapter.DEFAULT_START_URL,adapter=adapter,reader_selectors=adapter.READER_SELECTORS) as ctx:
                    path=Path(td)/'bridge_proof_first_image.png'
                    self.assertTrue(path.is_file())
                    self.assertEqual(path.read_bytes(),raw)
                    self.assertEqual(hashlib.sha256(path.read_bytes()).digest(),hashlib.sha256(raw).digest())
                    response=ctx.request.get('https://i.tngcdn.com/test.png')
                    self.assertEqual(response.capture_method,'rendered-png')
                    self.assertEqual(response.body(),raw)
                self.assertEqual(bridge.LocalBridge.test_case_actions,['probe','image'])
    def test_failure_to_probe_refuses_to_crawl(self):
        with tempfile.TemporaryDirectory() as td:
            with patch.object(bridge,'ensure_generated_extensions'),patch.object(bridge.LocalBridge,'start'),\
                 patch.object(bridge.LocalBridge,'wait_paired'),patch.object(bridge.LocalBridge,'close'),\
                 patch.object(bridge.LocalBridge,'rpc',return_value={'base64':''}):
                with self.assertRaises(bridge.BrowserBridgeError):
                    with bridge.source_extension_context(Path(td),adapter.DEFAULT_START_URL,adapter=adapter):
                        self.fail('Crawler must not begin')

if __name__=='__main__':unittest.main()
