"""Fail closed on normal-browser autolaunch and startup URL contract."""
from __future__ import annotations
import base64
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, Mock
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from reusable.browser_bridge import LocalBridge
from reusable import normal_browser_launch as launcher

SITE = 'https://reader.example.test/comic/a/chapter-62/'

class AutoNormalChromeTests(unittest.TestCase):
    def test_bootstrap_exposes_exact_requested_chapter(self):
        bridge = LocalBridge('https://reader.example.test/comic/a/', initial_chapter_url=SITE, port=0)
        bridge.start()
        try:
            with urlopen(Request(f'http://127.0.0.1:{bridge.port}/bootstrap', headers={
                'X-Comic-Bridge-Bootstrap':'1', 'X-Comic-Bridge-Client':'local-client-bridge'}), timeout=3) as resp:
                result = json.load(resp)
            self.assertEqual(result['startup_url'], SITE)
            self.assertEqual(result['site'], 'reader.example.test')
            self.assertGreaterEqual(len(result['token']), 20)
        finally:
            bridge.close()

    def test_managed_tab_handshake_rejects_stale_extension(self):
        from urllib.error import HTTPError
        bridge=LocalBridge('https://reader.example.test/comic/a/', initial_chapter_url=SITE,
                           port=0, require_managed_tab=True)
        bridge.start()
        try:
            base=f'http://127.0.0.1:{bridge.port}'
            headers={'X-Comic-Bridge-Token':bridge.secret,
                     'X-Comic-Bridge-Client':'local-managed-tab-test',
                     'Content-Type':'application/json'}
            def hello(obj):
                request=Request(base+'/hello',data=json.dumps(obj).encode(),headers=headers,method='POST')
                try:
                    with urlopen(request,timeout=3) as resp: return resp.status
                except HTTPError as exc: return exc.code
            client={'url':SITE,'bridge_protocol':'visual-transfer-2',
                    'capabilities':['probe','image','content-v2']}
            self.assertEqual(hello(client),409)
            self.assertFalse(bridge.ready.is_set())
            self.assertEqual(hello(dict(client,tab_ownership='extension-managed',tab_id=52)),200)
            self.assertTrue(bridge.ready.is_set())
            self.assertEqual(bridge.tab_id,52)
        finally:
            bridge.close()

    def test_first_verified_navigation_reuses_managed_document_only_once(self):
        from reusable.browser_bridge import BridgeContext
        b = LocalBridge('https://reader.example.test/comic/a/',
                        initial_chapter_url=SITE)
        b.tab_url = SITE
        b.startup_reader_verified = True
        ctx = BridgeContext(b, [], [])
        with patch.object(b, 'rpc', return_value={'url': SITE, 'status': 200}) as rpc:
            self.assertEqual(ctx.pages[0].goto(SITE).status, 200)
            rpc.assert_not_called()
            ctx.pages[0].goto(SITE)
            rpc.assert_called_once_with('navigate', {'url': SITE}, timeout=100)

    def test_unverified_or_different_startup_still_navigates(self):
        from reusable.browser_bridge import BridgeContext
        for verified, requested in ((False,SITE),(True,SITE+'other')):
            with self.subTest(verified=verified, requested=requested):
                b = LocalBridge('https://reader.example.test/comic/a/',
                                initial_chapter_url=SITE)
                b.tab_url = SITE
                b.startup_reader_verified = verified
                ctx = BridgeContext(b, [], [])
                with patch.object(b, 'rpc', return_value={'url':requested, 'status':200}) as rpc:
                    ctx.pages[0].goto(requested)
                    rpc.assert_called_once()

    def test_hello_requires_refreshed_extension_when_enabled(self):
        from urllib.error import HTTPError
        b = LocalBridge('https://reader.example.test/comic/a/',
                        initial_chapter_url=SITE, port=0, require_managed_tab=True)
        b.require_startup_refresh = True
        b.start()
        self.addCleanup(b.close)
        headers={'X-Comic-Bridge-Token':b.secret,
                 'X-Comic-Bridge-Client':'local-managed-tab-test',
                 'Content-Type':'application/json'}
        payload={'url':SITE,'bridge_protocol':'visual-transfer-2',
                 'capabilities':['probe','image','content-v2'],
                 'tab_ownership':'extension-managed','tab_id':32}
        def status():
            req=Request(f'http://127.0.0.1:{b.port}/hello',
                        data=json.dumps(payload).encode(),headers=headers,method='POST')
            try:
                with urlopen(req,timeout=3) as res:return res.status
            except HTTPError as exc:return exc.code
        self.assertEqual(status(),409)
        self.assertFalse(b.ready.is_set())
        payload['startup_refresh_revision']=1
        self.assertEqual(status(),200)
        self.assertTrue(b.ready.is_set())

    def test_refuses_cross_origin_or_http_startup(self):
        for bad in ('https://evil.example.test/x','http://reader.example.test/comic/a/chapter-62/'):
            with self.subTest(bad=bad), self.assertRaises(Exception):
                LocalBridge('https://reader.example.test/comic/a/',initial_chapter_url=bad)

    def test_normal_chrome_launch_uses_no_browser_automation_flags(self):
        calls = []
        def spawned(args,**kw): calls.append((args,kw))
        with patch.dict(os.environ, {'COMIC_ARCHIVER_CHROME_PROFILE_DIRECTORY':''}, clear=False):
            result=launcher.launch_normal_chrome(SITE, executable='C:/Chrome/chrome.exe', popen=spawned)
        self.assertEqual(result[:2], ['C:/Chrome/chrome.exe', '--new-tab'])
        self.assertRegex(result[2], r'^about:blank#comicarchiver-[a-f0-9]{32}$')
        self.assertEqual(calls[0][0],result)
        self.assertTrue(all('debugging' not in arg and 'automation' not in arg and
                            'user-data-dir' not in arg and 'headless' not in arg for arg in result))

    def test_profile_override_is_explicit_and_safe(self):
        with patch.dict(os.environ, {'COMIC_ARCHIVER_CHROME_PROFILE_DIRECTORY':'Profile 2'}):
            result=launcher.launch_normal_chrome(SITE,executable='chrome.exe',popen=lambda *_a,**_k:None)
            self.assertIn('--profile-directory=Profile 2',result)
        with patch.dict(os.environ, {'COMIC_ARCHIVER_CHROME_PROFILE_DIRECTORY':'Profile 2 --remote-debugging-port=0'}):
            with self.assertRaises(ValueError):
                launcher.launch_normal_chrome(SITE,executable='chrome.exe',popen=lambda *_a,**_k:None)

    def test_invalid_url_or_missing_chrome_never_spawns(self):
        with self.assertRaises(ValueError):
            launcher.launch_normal_chrome('javascript:alert(1)',executable='chrome.exe',popen=lambda *_a,**_k:self.fail('spawned'))
        with patch.object(launcher,'find_normal_chrome', return_value=None):
            with self.assertRaisesRegex(RuntimeError, 'Cannot find Chrome'):
                launcher.launch_normal_chrome(SITE,popen=lambda *_a,**_k:self.fail('spawned'))

    def test_context_opens_browser_only_after_server_ready(self):
        from types import SimpleNamespace
        from PIL import Image
        from reusable.browser_bridge import source_extension_context
        buffer = io.BytesIO()
        Image.new('RGB',(2,2)).save(buffer,format='PNG')
        events=[]
        fake=Mock(initial_chapter_url=SITE, rendered_image_selector=None, startup_nonce="a"*32)
        fake.start.side_effect=lambda:events.append('listener-ready')
        fake.wait_paired.side_effect=lambda:events.append('extension-paired')
        fake.rpc.side_effect=lambda *_a,**_kw:(events.append('image-proof') or
            {'base64':base64.b64encode(buffer.getvalue()).decode('ascii'),'via':'rendered-png'})
        adapter=SimpleNamespace(IMAGE_ATTRIBUTES=[],BRIDGE_IMAGE_HOSTS=[])
        def launched(url, *, startup_nonce):
            self.assertEqual(startup_nonce,"a"*32)
            self.assertEqual(url,SITE)
            events.append('normal-chrome-open')
            return ['chrome.exe','--new-tab','about:blank']
        with tempfile.TemporaryDirectory() as folder:
            with patch('reusable.browser_bridge.LocalBridge',return_value=fake), \
                 patch('reusable.browser_bridge.ensure_generated_extensions'), \
                 patch('reusable.normal_browser_launch.launch_normal_chrome',side_effect=launched), \
                 patch.dict(os.environ,{'COMIC_ARCHIVER_NO_AUTO_BROWSER':'0'}):
                with source_extension_context(Path(folder),'https://reader.example.test/comic/a/',
                         adapter=adapter,initial_chapter_url=SITE):
                    self.assertEqual(events[:4],['listener-ready','normal-chrome-open',
                                                  'extension-paired','image-proof'])
        fake.close.assert_called_once()

    def test_resume_picks_first_missing_chapter_and_keeps_website_adapter_untouched(self):
        root=Path(__file__).resolve().parents[1]
        engine=(root/'reusable/engine.py').read_text(encoding='utf-8')
        browser=(root/'reusable/browser_bridge.py').read_text(encoding='utf-8')
        self.assertIn('initial_chapter_url=(remaining[0].url if remaining else seed)',engine)
        self.assertIn('bridge.start()\n    # The loopback listener MUST be ready before opening Chrome',browser)
        self.assertIn('launch_normal_chrome(bridge.initial_chapter_url, startup_nonce=bridge.startup_nonce)',browser)
        self.assertIn("command.append('about:blank#comicarchiver-'",(root/'reusable/normal_browser_launch.py').read_text(encoding='utf-8'))
        self.assertNotIn('toongod', (root/'reusable/normal_browser_launch.py').read_text(encoding='utf-8').lower())

if __name__ == '__main__':unittest.main()
