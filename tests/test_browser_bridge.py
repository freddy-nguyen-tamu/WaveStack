import base64
import io
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.request import Request, urlopen
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from reusable import browser_bridge as bridge
from site_specific import site_adapter as adapter
from reusable import engine

SOURCE = adapter.DEFAULT_START_URL
# This transport regression suite must work after switching the one site adapter.
IMAGE_HOST = adapter.BRIDGE_IMAGE_HOSTS[0] if adapter.BRIDGE_IMAGE_HOSTS else SOURCE.split('/')[2]
IMAGE_URL = 'https://' + IMAGE_HOST + '/img.jpg'
PANEL_URL = 'https://' + IMAGE_HOST + '/panel.jpg'


class BrowserBridgeTests(unittest.TestCase):
    def test_generated_extensions_are_adapter_driven(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)
            (p/'reusable').mkdir()
            import shutil
            shutil.copytree(ROOT/'reusable'/'browser_bridge_extension',p/'reusable'/'browser_bridge_extension')
            a=type('AnotherSite',(),dict(EXTENSION_MATCHES=('https://manga.example/read/*',),
                                       BRIDGE_IMAGE_HOSTS=('images.example',)))
            bridge.ensure_generated_extensions(p,a,18765)
            m=json.loads((p/'browser_bridge'/'chrome'/'manifest.json').read_text())
            self.assertEqual(m['content_scripts'][0]['matches'],['https://manga.example/read/*'])
            self.assertIn('https://images.example/*',m['host_permissions'])
            script=(p/'browser_bridge'/'chrome'/'background.js').read_text()
            self.assertNotIn('toongod.org', script)
            self.assertNotIn('annoying-alice', script)
            self.assertIn("chrome.runtime.getManifest()", script)

    def test_native_catalog_still_all_98_and_53_pages(self):
        source=Path('/mnt/data/Pasted text(20261121-000542).txt')
        if not source.exists():self.skipTest('Not running with user original attached HTML')
        raw=source.read_text(encoding='utf-8')
        chapters=engine.custom_chapter_links(raw,SOURCE)
        self.assertEqual(len(chapters),98)
        self.assertEqual(chapters[-1].chapter_id,'98')
        self.assertEqual(len(engine.snapshot_images(raw)),53)

    def test_image_restriction_and_site_domain(self):
        b=bridge.LocalBridge(SOURCE,image_hosts=adapter.BRIDGE_IMAGE_HOSTS)
        b.validate_chapter(SOURCE)
        b.validate_image(PANEL_URL)
        for url in ['http://www.toongod.org/webtoon/annoying-alice/chapter-1/',
                    'https://example.com/chapter-2/']:
            with self.assertRaises(bridge.BrowserBridgeError):b.validate_chapter(url)
        with self.assertRaises(bridge.BrowserBridgeError):b.validate_image('https://google.com/x.png')

    def test_live_loopback_pairing_rpc_and_bytes(self):
        b=bridge.LocalBridge(SOURCE,image_hosts=adapter.BRIDGE_IMAGE_HOSTS,port=0)
        b.start()
        b.port=b.server.server_port
        url='http://127.0.0.1:'+str(b.port)
        origin='chrome-extension://test-extension'
        def api(path,data=None,secret=None,origin_header=origin):
            payload=json.dumps(data).encode() if data is not None else None
            headers={'X-Comic-Bridge-Token':secret or b.secret,'Origin':origin_header,
                     'X-Comic-Bridge-Client':'test-broker-client-123'}
            if data is not None:headers['Content-Type']='application/json'
            request=Request(url+path,data=payload,headers=headers,method='POST' if data is not None else 'GET')
            with urlopen(request,timeout=5) as response:
                return json.loads(response.read())
        try:
            # Browser page cannot steal commands: must present extension origin.
            from urllib.error import HTTPError
            with self.assertRaises(HTTPError) as exc:
                api('/next',origin_header='https://www.toongod.org')
            self.assertEqual(exc.exception.code,403)
            with self.assertRaises(HTTPError) as exc:
                api('/next',secret='wrong')
            self.assertEqual(exc.exception.code,401)
            # An outdated extension used to say connected while lacking the
            # Python 'probe' command; reject it before any crawling begins.
            with self.assertRaises(HTTPError) as outdated:
                api('/hello',{'url':SOURCE})
            self.assertEqual(outdated.exception.code,409)
            self.assertFalse(b.ready.is_set())
            b.outdated_client.clear()
            self.assertTrue(api('/hello',{'url':SOURCE,'bridge_protocol':bridge.BRIDGE_PROTOCOL,'capabilities':['probe','image','content-v2']})['ok'])
            self.assertTrue(b.ready.is_set())
            seen=[]
            def simulate():
                for _ in range(3):
                    while True:
                        command=api('/next')['command']
                        if command:break
                        time.sleep(.015)
                    seen.append(command['action'])
                    data = {'url':SOURCE,'html':'<html>example</html>'} if command['action']=='page' else \
                           {'url':SOURCE,'status':200} if command['action']=='navigate' else \
                           {'status':200,'url':IMAGE_URL,'base64':base64.b64encode(b'bytes').decode()}
                    api('/result',{'id':command['id'],'ok':True,'data':data})
            t=threading.Thread(target=simulate,daemon=True)
            t.start()
            ctx=bridge.BridgeContext(b,adapter.READER_SELECTORS,adapter.IMAGE_ATTRIBUTES)
            page=ctx.pages[0]
            self.assertIn('example',page.content())
            self.assertEqual(page.goto(SOURCE).status,200)
            img=ctx.request.get(IMAGE_URL)
            self.assertEqual(img.body(),b'bytes')
            self.assertEqual(seen,['page','navigate','image'])
            t.join(timeout=2)
        finally:b.close()

    def test_cdn_403_is_not_misclassified_as_chapter_challenge(self):
        from reusable.source_session import SourceAccessPaused
        b=bridge.LocalBridge(SOURCE,image_hosts=adapter.BRIDGE_IMAGE_HOSTS)
        b.ready.set();b.tab_url=SOURCE
        ctx=bridge.BridgeContext(b,adapter.READER_SELECTORS,adapter.IMAGE_ATTRIBUTES)
        with patch.object(b,'rpc',return_value={'status':403,'url':IMAGE_URL,'base64':''}):
            with self.assertRaises(SourceAccessPaused) as raised:
                ctx.request.get(IMAGE_URL)
            self.assertIn('CDN',str(raised.exception))
            self.assertIn('debugger',str(raised.exception))

    def test_chromium_debugger_permission_generated_from_generic_adapter(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            source=Path(__file__).resolve().parents[1]/'reusable'/'browser_bridge_extension'
            import shutil
            shutil.copytree(source,root/'reusable'/'browser_bridge_extension')
            target=bridge.ensure_generated_extensions(root,adapter,18765)
            m=json.loads((target/'chrome'/'manifest.json').read_text('utf-8'))
            self.assertIn('debugger',m['permissions'])
            self.assertIn('https://' + IMAGE_HOST + '/*',m['host_permissions'])
            self.assertNotIn('debugger',json.loads((target/'firefox'/'manifest.json').read_text('utf-8'))['permissions'])

    def test_one_tab_no_page_close_and_operations(self):
        b=bridge.LocalBridge(SOURCE,image_hosts=adapter.BRIDGE_IMAGE_HOSTS)
        b.ready.set();b.tab_url=SOURCE
        ctx=bridge.BridgeContext(b,adapter.READER_SELECTORS,adapter.IMAGE_ATTRIBUTES)
        self.assertIs(ctx.pages[0],ctx.new_page())
        with patch.object(b,'rpc',return_value={'imgs':[],'total':0}) as mocked:
            page=ctx.new_page()
            page.close()
            self.assertEqual(page.evaluate('() => {return {imgs:[]}}')['total'],0)
            self.assertEqual(mocked.call_args.args[0],'snapshot')
            page.evaluate('() => { scrollTo(0,100); }')
            self.assertEqual(mocked.call_args.args[0],'scroll')


if __name__=='__main__':unittest.main()
