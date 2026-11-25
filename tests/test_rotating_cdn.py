"""Unknown host is authorized for decoded scoped pixels only, never HTTP fetch."""
import base64
import unittest
from types import SimpleNamespace
from unittest.mock import Mock
from reusable.browser_bridge import LocalBridge, BridgeRequest, BrowserBridgeError, _probe_with_one_quiet_image_grace
from site_specific import site_adapter as a

class ScopedRenderedTests(unittest.TestCase):
    def setUp(self):
        self.url='https://rotating.example/hi/panel_123'
        self.known='https://known.example/hi/panel_123'
        self.sel='.reader img.panel'
        self.bridge=LocalBridge('https://reader.example/chapter-1',image_hosts=('known.example',),
                                rendered_image_selector=self.sel,
                                rendered_image_validator=lambda u:u.startswith('https://rotating.example/hi/'))
        self.bridge.rpc=Mock(return_value={'url':self.url,'status':200,'base64':base64.b64encode(b'pixels').decode(),
                              'via':'rendered-png','rendered_reader_revision':'scoped-rendered-reader-v1'})
        self.req=BridgeRequest(SimpleNamespace(bridge=self.bridge))
    def test_unknown_scoped_transfer(self):
        self.assertEqual(self.req.get(self.url).body(),b'pixels')
        self.bridge.rpc.assert_called_once_with('image',{'url':self.url,'rendered_reader_selector':self.sel})
    def test_old_response_or_wrong_url_rejected(self):
        for fields in ({'via':'original-response'},{'url':self.known},{'rendered_reader_revision':None}):
            self.bridge.rpc.return_value.update(fields)
            with self.assertRaises(BrowserBridgeError):self.req.get(self.url)
    def test_no_optin_denies(self):
        b=LocalBridge('https://reader.example/chapter-1',image_hosts=('known.example',))
        with self.assertRaises(BrowserBridgeError):b.validate_image(self.url)
        with self.assertRaises(BrowserBridgeError):self.bridge.validate_image('https://evil.example/hi/panel')
        self.assertIsNone(self.bridge.rendered_only_selector(self.known))
        self.assertEqual(self.bridge.validate_image(self.known),self.known)
    def test_probe_uses_scope(self):
        _probe_with_one_quiet_image_grace(self.bridge,('.reader',))
        self.bridge.rpc.assert_called_once_with('probe',{'reader_selectors':['.reader'],'rendered_reader_selector':self.sel},timeout=55)

@unittest.skipUnless(a.SOURCE_NAME=='comix-orange-marmalade','active adapter differs')
class ComixRotatingHostTests(unittest.TestCase):
    def test_three_unlisted_hosts_and_placeholders(self):
        urls=[f'https://lov.{host}.site/hi/token{i}' for i,host in enumerate(('digitalsoulstudio','notesfromkatie','softfabricstore'),1)]
        segs=''.join(f'<button class="rpage-progress__seg" aria-label="Go to page {i}"></button>' for i in range(1,50))
        slots=''.join(f'<div class="rpage-page" data-page="{i}">'+(f'<img class="rpage-page__img" src="{urls[i-1]}">' if i<=3 else '<div class="rpage-page__loader"></div>')+'</div>' for i in range(1,50))
        html=segs+'<div class="rpage-main__inner">'+slots+'<img src="https://ad.example/ad.png"></div>'
        observations=[{'key':str(i),'url':u,'loaded':True,'width':700,'height':1248,'pageY':(i-1)*1248} for i,u in enumerate(urls,1)]
        page=SimpleNamespace(url=a._NEXT,content=lambda:html,evaluate=lambda _:dict(imgs=observations,bottom=60000,viewportHeight=717,scrollY=0))
        info=a.custom_page_snapshot(page)
        self.assertEqual(info['total'],49);self.assertEqual(info['missingSlots'],46)
        self.assertEqual([im['url'] for im in info['imgs'][:3]],urls)
        self.assertEqual([im['key'] for im in info['imgs']],[str(i) for i in range(1,50)])
        self.assertTrue(all(a.accept_rendered_image_url(u) for u in urls))
        self.assertTrue(all(__import__('urllib.parse',fromlist=['urlsplit']).urlsplit(u).hostname not in a.BRIDGE_IMAGE_HOSTS for u in urls))
    def test_malformed_paths_refused(self):
        for url in ['http://cdn.example/hi/token','https://127.0.0.1/hi/token','https://cdn.example:443/hi/token','https://user@cdn.example/hi/token','https://cdn.example/ad.png']:
            self.assertFalse(a.accept_rendered_image_url(url),url)
