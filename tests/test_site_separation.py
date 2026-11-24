"""Provider-agnostic build and guard against source URL leakage."""
import json
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock
from reusable.bridge_manifest import generate_installed_manifests

ROOT=Path(__file__).resolve().parents[1]

class Tests(unittest.TestCase):
    def test_no_provider_patterns_or_placeholder_urls_in_reusable(self):
        for relative in ('reusable/engine.py',
                         'reusable/extension_templates/content.template.js',
                         'reusable/browser_bridge_extension/manifest.chrome.json',
                         'reusable/browser_bridge_extension/manifest.firefox.json'):
            data=(ROOT/relative).read_text(encoding='utf-8').lower()
            for forbidden in ('toongod.org','tngcdn.com','webtoons.com','toptoon.com','annoying-alice','bg_transparency'):
                self.assertNotIn(forbidden,data,relative)

    def test_generated_site_patterns_come_from_adapter_only(self):
        with tempfile.TemporaryDirectory() as temp:
            temp=Path(temp)
            for browser in ('chrome','firefox'):
                src=temp/'reusable/browser_bridge_extension'/f'manifest.{browser}.json'
                src.parent.mkdir(parents=True,exist_ok=True)
                src.write_bytes((ROOT/'reusable/browser_bridge_extension'/f'manifest.{browser}.json').read_bytes())
            fake=types.SimpleNamespace(EXTENSION_MATCHES=['https://fictional-reader.example/episodes/*'],
                 ALLOWED_HOSTS=['fictional-reader.example'],BRIDGE_IMAGE_HOSTS=['pictures.example'])
            before=(temp/'reusable/browser_bridge_extension/manifest.chrome.json').read_bytes()
            changes=generate_installed_manifests(temp,fake)
            self.assertEqual(set(changes),{'chrome','firefox'})
            self.assertEqual(before,(temp/'reusable/browser_bridge_extension/manifest.chrome.json').read_bytes())
            for browser in ('chrome','firefox'):
                got=json.loads((temp/'browser_bridge'/browser/'manifest.json').read_text())
                self.assertEqual(got['content_scripts'][0]['matches'],fake.EXTENSION_MATCHES)
                self.assertIn('https://pictures.example/*',got.get('host_permissions',[])+got['permissions'])
            self.assertEqual(generate_installed_manifests(temp,fake),[])

    def test_rejects_invalid_pattern_and_host(self):
        with tempfile.TemporaryDirectory() as temp:
            fake=types.SimpleNamespace(EXTENSION_MATCHES=['http://example.com/*'],ALLOWED_HOSTS=['example.com'],BRIDGE_IMAGE_HOSTS=[])
            with self.assertRaises(ValueError):generate_installed_manifests(Path(temp),fake)
            fake.EXTENSION_MATCHES=['https://example.com/*'];fake.BRIDGE_IMAGE_HOSTS=['bad/host']
            with self.assertRaises(ValueError):generate_installed_manifests(Path(temp),fake)


@unittest.skipUnless(__import__('site_specific.site_adapter',fromlist=['SOURCE_NAME']).SOURCE_NAME=='mangadex-wotakoi-en',
                     'MangaDex-specific fixture is inactive when using another site adapter')
class MangaDexAdapterContract(unittest.TestCase):
    """Adapter/API fixtures are offline: run.py must not query MangaDex during preflight."""
    def setUp(self):
        from site_specific import site_adapter as a
        from unittest.mock import patch
        self.a=a
        self.saved=(a._SEED,a._FEED,dict(a._AT_HOME),dict(a._DOM),set(a._IMAGE_URLS),dict(a._ALT_NAMES))
        a._SEED=None;a._FEED=None;a._AT_HOME.clear();a._DOM.clear();a._IMAGE_URLS.clear();a._ALT_NAMES.clear()
        self.seed='a2524342-07a7-4b9d-998d-c1ac081f7b3c'
        self.manga='65263bf9-4f87-4513-b72f-ad6436b3911c'
        self.c1='2827a899-e0c6-4f36-a4c9-ab7d11803d6a'
        self.c2='b25a5bb6-0000-4000-8000-000000000002'
        self.dupe='b25a5bb6-0000-4000-8000-000000000003'
        def chapter(id_,ch,volume=None,group='groupset',lang='en'):
            return {'id':id_, 'attributes':{'translatedLanguage':lang,'chapter':str(ch), 'volume':volume,
                     'title':'Chapter '+str(ch), 'publishAt':'2026-01-01T00:00:00+00:00'},
                    'relationships':[{'type':'manga','id':self.manga},
                      {'type':'scanlation_group','id':group}]}
        self.feed=[chapter(self.c2,2),chapter(self.c1,1),chapter(self.dupe,1,group='other'),
                   chapter(self.seed,0)]
        def fake_api(path,*,params=None):
            if path=='/chapter/'+self.seed:
                return {'result':'ok','data':self.feed[-1]}
            if path=='/manga/'+self.manga+'/feed':
                opts=dict(params or [])
                if opts.get('translatedLanguage[]')!='en':raise AssertionError('language selection was lost')
                offset=int(opts['offset'])
                return {'result':'ok','total':4,'data':self.feed[offset:offset+100]}
            if path=='/at-home/server/'+self.seed:
                return {'result':'ok','baseUrl':'https://cache.mangadex.network',
                        'chapter':{'hash':'ab'*16,'data':['x1-a.png','x2-b.png','x3-c.png']}}
            raise AssertionError('Unexpected API endpoint '+path)
        self.mock=patch.object(a,'_api_json',side_effect=fake_api);self.mock.start()

    def tearDown(self):
        self.mock.stop()
        a=self.a
        a._SEED,a._FEED,old_cache,old_dom,old_urls,old_alts=self.saved
        a._AT_HOME.clear();a._AT_HOME.update(old_cache)
        a._DOM.clear();a._DOM.update(old_dom)
        a._IMAGE_URLS.clear();a._IMAGE_URLS.update(old_urls)
        a._ALT_NAMES.clear();a._ALT_NAMES.update(old_alts)

    def test_feed_uses_only_verified_chapter_uuids_and_dedupes_same_language(self):
        from reusable.engine import Chapter
        chapters=self.a.custom_chapters('',self.a.DEFAULT_START_URL,Chapter)
        self.assertEqual([x.chapter_id for x in chapters],
                         ['mdx-'+self.seed,'mdx-'+self.c1,'mdx-'+self.c2])
        self.assertEqual(len(chapters),3)
        self.assertNotIn('Chapter 3',[x.label for x in chapters])
        self.assertTrue(all(x.url.startswith('https://mangadex.org/chapter/') for x in chapters))

    def test_reader_uses_real_manifest_filenames_and_preserves_order(self):
        a=self.a
        from types import SimpleNamespace
        class Page:
            url=a.DEFAULT_START_URL
            def __init__(self,ordered):self.ordered=ordered
            def evaluate(self,script):
                self.seen_script=script
                return {'imgs':[{'key':str(i+1),'url':'','loaded':True,'width':12,'height':40,
                          'pageY':i*100} for i in range(len(self.ordered))],
                        'scrollY':240,'bottom':240,'height':500,'viewportHeight':260,'revision':0}
            def content(self):
                return '<section class="md--reader-pages">'+''.join(
                    '<img alt="'+name+'" src="blob:https://mangadex.org/image'+str(i)+'">'
                    for i,name in enumerate(self.ordered))+'</section>'
        ordered=['x1-a.png','x2-b.png','x3-c.png']
        good=a.custom_page_snapshot(Page(ordered))
        self.assertEqual([v['key'] for v in good['imgs']],['1','2','3'])
        self.assertEqual(good['missingSlots'],0)
        self.assertTrue(all(v['url'].startswith('https://cache.mangadex.network/data/') for v in good['imgs']))
        a._DOM.clear()
        with self.assertRaisesRegex(RuntimeError,'order differs'):
            a.custom_page_snapshot(Page([ordered[1],ordered[0],ordered[2]]))

    def test_saver_quality_filename_maps_to_canonical_panel_order(self):
        a=self.a
        from unittest.mock import patch
        chapter=a._uuid_from_url(a.DEFAULT_START_URL)
        names=['x1-a.png','x2-b.png','x3-c.png']
        savers=['x1-s.jpg','x2-s.jpg','x3-s.jpg']
        with patch.object(a,'_api_json',return_value={'result':'ok',
             'baseUrl':'https://cache.mangadex.network',
             'chapter':{'hash':'ab'*16,'data':names,'dataSaver':savers}}):
            got,url=a._at_home(chapter)
        self.assertEqual(got,tuple(names))
        self.assertEqual(a._ALT_NAMES[chapter]['x2-s.jpg'],1)
        class Page:
            url=a.DEFAULT_START_URL
            def evaluate(self,script):
                return {'imgs':[{'key':'1','loaded':True,'width':100,'height':150,'pageY':0},
                                {'key':'2','loaded':True,'width':100,'height':150,'pageY':150}],
                        'scrollY':250,'bottom':250,'height':300,'viewportHeight':200}
            def content(self):
                return '<div class="md--reader-pages"><img alt="x1-s.jpg" src="blob:https://mangadex.org/a" /><img alt="x2-s.jpg" src="blob:https://mangadex.org/b" /></div>'
        snapshot=a.custom_page_snapshot(Page())
        self.assertEqual([v['url'] for v in snapshot['imgs']],list(url))
        self.assertEqual(len(snapshot['imgs']),3)

    def test_unavailable_page_is_not_treated_as_last_chapter(self):
        a=self.a
        a._SEED=None;a._FEED=None
        from unittest.mock import patch
        real=a._api_json
        def truncated(path,*,params=None):
            if path.endswith('/feed'):
                return {'result':'ok','total':5,'data':[]}
            return real(path,params=params)
        with patch.object(a,'_api_json',side_effect=truncated):
            with self.assertRaisesRegex(RuntimeError,'prematurely'):
                a.custom_chapters('',a.DEFAULT_START_URL,object)

    def test_untrusted_cdn_and_unknown_image_are_rejected(self):
        a=self.a
        from unittest.mock import patch
        with self.assertRaisesRegex(RuntimeError,'not present'):
            a._http_image_get('https://arbitrary.invalid/a.png')
        with patch.object(a,'_api_json',return_value={'result':'ok','baseUrl':'https://evil.invalid',
              'chapter':{'hash':'a'*32,'data':['x1-a.png']}}):
            with self.assertRaisesRegex(RuntimeError,'Unrecognized'):
                a._at_home(self.c1)

    def test_regular_browser_snapshot_requires_matching_real_filename(self):
        a=self.a
        class Page:
            url=a.DEFAULT_START_URL
            def evaluate(self,s):return {'imgs':[{'key':'1','loaded':True,'width':10,'height':20,'pageY':0}],
                                          'scrollY':0,'bottom':0,'height':100,'viewportHeight':100}
            def content(self):return '<div class="md--reader-pages"><img alt="wrong.png" src="blob:https://mangadex.org/ok"></div>'
        with self.assertRaisesRegex(RuntimeError,'order differs'):
            a.custom_page_snapshot(Page())




class GenericDecodedBlobReadiness(unittest.TestCase):
    def test_bridge_accepts_only_loaded_same_source_blob_as_passive_readiness(self):
        from reusable.browser_bridge import BridgePage, LocalBridge
        bridge=LocalBridge('https://example.test/chapter/abc')
        fake=types.SimpleNamespace(bridge=bridge,
            reader_selectors=['.reader'],image_attributes=['src'])
        page=BridgePage(fake)
        page._last_html='<div class="reader"><img src="blob:https://example.test/x"></div>'
        result={'imgs':[{'url':'blob:https://example.test/some-id','loaded':True,
                         'width':900,'height':1200}]}
        with mock.patch.object(bridge,'rpc',return_value=result):
            self.assertTrue(page.reader_ready())
            result['imgs'][0]['loaded']=False
            self.assertFalse(page.reader_ready())
            result['imgs'][0]['loaded']=True
            result['imgs'][0]['url']='blob:https://evil.test/some-id'
            self.assertFalse(page.reader_ready())
            result['imgs'][0]['url']='blob:http://example.test/some-id'
            self.assertFalse(page.reader_ready())


class MangaDexVirtualImageRegressions(unittest.TestCase):
    @unittest.skipUnless(__import__('site_specific.site_adapter',fromlist=['SOURCE_NAME']).SOURCE_NAME=='mangadex-wotakoi-en',
                         'This provider fixture only runs while the MangaDex adapter is active')
    def test_api_manifest_is_complete_when_browser_has_partial_lazy_dom(self):
        from unittest.mock import patch
        from site_specific import site_adapter as adapter
        uuid=adapter._uuid_from_url(adapter.DEFAULT_START_URL)
        files=('a-1.png','b-2.png','c-3.png')
        urls=tuple('https://cache.mangadex.network/data/'+'abc'*12+'/'+file for file in files)
        class Page:
            url=adapter.DEFAULT_START_URL
            def evaluate(self,script):
                return {'imgs':[{'key':'1','loaded':True,'width':500,'height':900,'pageY':0}],
                        'scrollY':500,'bottom':500,'height':1200,'viewportHeight':700}
            def content(self):
                return '<div class="md--reader-pages"><img alt="a-1.png" src="blob:https://mangadex.org/uuid" /></div>'
        with patch.object(adapter,'_at_home',return_value=(files,urls)):
            snapshot=adapter.custom_page_snapshot(Page())
        self.assertEqual([x['url'] for x in snapshot['imgs']],list(urls))
        self.assertEqual(snapshot['missingSlots'],0)
        self.assertEqual(snapshot['unloadedSlots'],0)
        self.assertEqual(len(snapshot['imgs']),3)
        # DOM names must still agree with API order for every mounted image.
        adapter._DOM.pop(uuid,None)
        class Bad(Page):
            def content(self):
                return '<div class="md--reader-pages"><img alt="c-3.png" src="blob:https://mangadex.org/uuid" /><img alt="a-1.png" src="blob:https://mangadex.org/other" /></div>'
            def evaluate(self,script):
                return {**super().evaluate(script),'imgs':[{'key':'1'},{'key':'2'}]}
        with patch.object(adapter,'_at_home',return_value=(files,urls)):
            with self.assertRaisesRegex(RuntimeError,'order differs'):
                adapter.custom_page_snapshot(Bad())


class AdapterStableImageIdentity(unittest.TestCase):
    # When a site adapter uses stable local checkpoint IDs for browser-created
    # blobs, the current DOM URL—not a cached, revoked UUID—must be transferred.
    @unittest.skipUnless(__import__('site_specific.site_adapter',fromlist=['SOURCE_NAME']).SOURCE_NAME
                         == 'manhwaread-childhood-friends',
                         'Local-blob checkpoint fixture only applies to this adapter')
    def test_blob_recreation_rebinds_exact_ordinal_and_preserves_png_fidelity(self):
        import base64
        from types import SimpleNamespace
        from site_specific import site_adapter as a
        first='blob:https://manhwaread.com/old-uuid'
        current='blob:https://manhwaread.com/new-uuid'
        called=[]
        payload=b'valid-png-transport-test-fixture'
        class Page:
            url=a.DEFAULT_START_URL
            current_src=first
            def __init__(self):
                self.context=SimpleNamespace(
                    bridge=SimpleNamespace(rpc=self.rpc), request=SimpleNamespace())
            def evaluate(self,_script):
                return {'imgs':[{'key':'1','url':self.current_src,'loaded':True,
                    'width':720,'height':5000,'pageY':0}],
                    'scrollY':0,'bottom':4500,'height':5000,'viewportHeight':500}
            def rpc(self,action,args,timeout=0):
                called.append((action,dict(args)))
                return {'status':200,'base64':base64.b64encode(payload).decode(),
                  'via':'decoded-source-img-pixels','headers':{'content-type':'image/png'}}
            def recover_unloaded_image(self,key,url,**kw):
                called.append(('recover',{'key':key,'url':url,**kw}))
                return {'loaded':True,'key':key}
        page=Page()
        a.after_chapter_visit(page,page.url)
        snapshot=a.custom_page_snapshot(page)
        url=snapshot['imgs'][0]['url']
        self.assertEqual(snapshot['imgs'][0]['key'],'1')
        page.current_src=current
        result=page.context.request.get(url)
        self.assertEqual(result.body(),payload)
        self.assertEqual(result.capture_method,'decoded-source-img-pixels')
        self.assertTrue(called[-1][1]['require_clean_pixels'],
                        'adapter must disallow UI-contaminated viewport capture')
        # Preserve the original screenshot transport for other providers, but
        # reject it when the current adapter requires source-only pixels.
        page.context.bridge.rpc=lambda *args,**kwargs: {
            'status':200,'base64':base64.b64encode(payload).decode(),
            'via':'rendered-png','headers':{'content-type':'image/png'}}
        with self.assertRaisesRegex(RuntimeError,'Refusing screenshot-derived image'):
            page.context.request.get(url)
        page.context.bridge.rpc=page.rpc
        self.assertEqual(called[-1][1]['url'],current)
        self.assertEqual(page.recover_unloaded_image('1',url)['loaded'],True)
        self.assertEqual(called[-1][1]['url'],current,
                         'recovery must use actual DOM source, not virtual checkpoint URL')
        page.current_src='blob:https://other.invalid/forged'
        with self.assertRaisesRegex(RuntimeError,'same-origin'):
            page.context.request.get(url)
        # Subsequent chapter entry must not stack recursive recovery wrappers.
        page.current_src=current
        a.after_chapter_visit(page,page.url)
        a.custom_page_snapshot(page)
        self.assertEqual(page.recover_unloaded_image('1',url)['loaded'],True)


if __name__=='__main__':unittest.main()
