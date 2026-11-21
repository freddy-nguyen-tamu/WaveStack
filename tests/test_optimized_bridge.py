"""No network/sandbox access; tests startup-critical optimizations in reusable code."""
import ast
import io
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit
from unittest.mock import Mock

from PIL import Image
from reusable.browser_bridge import LocalBridge, BridgeRequest

ROOT=Path(__file__).resolve().parents[1]
ENGINE=ROOT/'reusable'/'engine.py'

def image_download_function():
    # Isolate the generic downloader to avoid importing deployment dependencies.
    tree=ast.parse(ENGINE.read_text(encoding='utf8'))
    target=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='image_download')
    import hashlib, time
    ns={'Path':Path,'Image':Image,'io':io,'hashlib':hashlib,'time':time,'urlsplit':urlsplit,
        'CONFIG':{'github_max_file_bytes':100000000},'SourceAccessPaused':RuntimeError,
        'event':lambda *args,**kwargs:None}
    exec(compile(ast.Module(body=[target],type_ignores=[]), str(ENGINE), 'exec'),ns)
    return ns['image_download']

class OptimizedBridgeTests(unittest.TestCase):
    def test_image_and_scroll_no_fixed_wallclock_timeout(self):
        source=(ROOT/'reusable/browser_bridge.py').read_text(encoding='utf8')
        self.assertIn('def rpc(self, action, payload=None, timeout=None)',source)
        self.assertIn("self.context.bridge.rpc('image', {'url': url})",source)
        self.assertIn("self.context.bridge.rpc('scroll')",source)
        self.assertNotIn('timeout=max(100',source)
        self.assertNotIn('q.get(timeout=timeout)',source)
    def test_heartbeat_endpoint_with_local_token(self):
        from urllib.request import Request,urlopen
        import json,time
        b=LocalBridge('https://example.com/chapter/',port=0)
        b.start()
        try:
            # Simulate the existing /hello pairing before heartbeat.
            b.extension_client='example1234'
            b.last_heartbeat=time.monotonic()-50
            req=Request(f'http://127.0.0.1:{b.port}/heartbeat',method='POST',
                data=b'{}',headers={'X-Comic-Bridge-Client':'example1234',
                                  'X-Comic-Bridge-Token':b.secret,'Content-Type':'application/json'})
            with urlopen(req,timeout=4) as r:self.assertTrue(json.load(r)['ok'])
            self.assertLess(time.monotonic()-b.last_heartbeat,2)
        finally:b.close()
    def test_loaded_cross_origin_pixel_copy_has_no_redundant_pacing(self):
        buf=io.BytesIO();Image.new('RGB',(16,20)).save(buf,format='PNG')
        response=SimpleNamespace(status=200,ok=True,url='https://cdn.example/1.png',
                                 headers={},body=lambda:buf.getvalue())
        request=SimpleNamespace(reuses_loaded_page_images=True,get=Mock(return_value=response))
        guard=SimpleNamespace(before=Mock(),response=Mock())
        with tempfile.TemporaryDirectory() as tmp:
            path,_=image_download_function()(SimpleNamespace(request=request),response.url,
                Path(tmp)/'0001','https://reader.example/chapter',max_tries=1,guard=guard)
            self.assertEqual(path.name,'0001.png');self.assertEqual(path.read_bytes(),buf.getvalue())
        guard.before.assert_not_called();guard.response.assert_not_called()
        self.assertEqual(request.get.call_count,1)
    def test_real_fetch_still_obeys_source_rate_and_result_guard(self):
        buf=io.BytesIO();Image.new('RGB',(16,20)).save(buf,format='PNG')
        response=SimpleNamespace(status=200,ok=True,url='https://reader.example/1.png',
                                 headers={},body=lambda:buf.getvalue())
        request=SimpleNamespace(reuses_loaded_page_images=True,get=Mock(return_value=response))
        guard=SimpleNamespace(before=Mock(),response=Mock())
        with tempfile.TemporaryDirectory() as tmp:
            image_download_function()(SimpleNamespace(request=request),response.url,
                Path(tmp)/'0001','https://reader.example/chapter',max_tries=1,guard=guard)
        guard.before.assert_called_once();guard.response.assert_called_once()
    def test_forward_streaming_uses_one_capture_attempt_before_targeted_retry(self):
        s=ENGINE.read_text(encoding='utf8')
        self.assertIn("max_tries=(1 if getattr(context.request,",s)
        self.assertIn("else config['download_retries'])",s)
        self.assertIn('IMAGE_DEFERRED_FOR_TARGETED_RETRY',s)

if __name__=='__main__':unittest.main()
