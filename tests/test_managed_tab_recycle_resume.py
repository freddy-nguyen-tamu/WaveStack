"""Keep stalled-scroll recovery within the current chapter and preserve checkpoints."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from reusable import engine
from reusable.browser_bridge import BrowserManagedTabRecycled, BridgePage


class RecycleTests(unittest.TestCase):
    def test_scroll_marker_restarts_scanner_not_double_scroll(self):
        class Bridge:
            def validate_chapter(self, url): return url
            def rpc(self, action, payload=None):
                self.calls.append(action)
                return {'transport_reset':True,'url':'https://example.test/chapter/83/'}
        b=Bridge(); b.calls=[]; b.tab_url="https://example.test/chapter/83/"
        ctx=SimpleNamespace(bridge=b)
        page=BridgePage(ctx)
        with self.assertRaises(BrowserManagedTabRecycled):
            page.evaluate("() => { scrollTo({top:scrollY+100}); }")
        self.assertEqual(b.calls,['scroll'])
        self.assertEqual(page.url,'https://example.test/chapter/83/')

        # Regression from the user's real 1.5.17 Chrome run: a successful
        # SCROLL returns an integer, not a transport-reset dictionary.
        class ScalarBridge:
            tab_url='https://example.test/chapter/83/'
            def __init__(self, result):
                self.result=result
                self.calls=[]
            def rpc(self, action, payload=None):
                self.calls.append(action)
                return self.result
        for scalar in (0, 1, 320, 38272, -5):
            b=ScalarBridge(scalar)
            page=BridgePage(SimpleNamespace(bridge=b))
            self.assertEqual(page.evaluate('() => scrollBy(0, 200)'),scalar)
            self.assertEqual(b.calls,['scroll'])
        # Successful structured payloads are also valid and must not trigger
        # a recycled-tab restart unless transport_reset is truthy.
        b=ScalarBridge({'scrollY':400,'at_bottom':False})
        self.assertEqual(BridgePage(SimpleNamespace(bridge=b)).evaluate('() => scrollBy(0, 200)'),
                         {'scrollY':400,'at_bottom':False})
        self.assertEqual(b.calls,['scroll'])

    def test_chapter_resumes_verified_prefix_from_same_saved_dict(self):
        url='https://example.test/chapter/83/'
        img_url='https://images.example.test/001.jpg'
        calls=[]; downloads=[]; events=[]
        class Page:
            def __init__(self): self.url=url
            def goto(self,*a,**k): pass
            def content(self): return '<title>Chapter 83</title>'
            def close(self): pass
        class Checkpoint:
            def __init__(self,*args): self.items={}
            def catalog_matches(self,*args): return False
            def reuse(self,*args): return None
            def record_image(self,key,i,image_url,path,meta):
                self.items[key]=(path,meta);return (path,meta)
        def scan(page,*args,**kwargs):
            calls.append('scan')
            progress=kwargs['on_progress']
            info={'imgs':[{'key':'1','url':img_url,'loaded':True,'width':720,'height':700,'pageY':0}],
                  'total':1,'scrollY':0,'viewportHeight':800,'missingSlots':0,'physicalAtBottom':False}
            progress(info,['1'],{'1':{'url':img_url,'width':720,'height':700}},True)
            if len(calls)==1:
                raise BrowserManagedTabRecycled('new tab ready')
            return [('1',{'url':img_url,'width':720,'height':700})]
        def download(_ctx,image,target,_chapter,**_kwargs):
            downloads.append(image)
            return Path(str(target)+'.jpg'),{'filename':'0001.jpg','order':1,'source_url':image,'bytes':77}
        with tempfile.TemporaryDirectory() as tmp:
            context=SimpleNamespace(new_page=lambda:Page(),
                request=SimpleNamespace(reuses_loaded_page_images=True))
            chapter=SimpleNamespace(chapter_id='83',url=url,label='Episode 83')
            with patch.object(engine,'ChapterImageCheckpoint',Checkpoint), \
                 patch.object(engine,'scan_browser_images',scan), \
                 patch.object(engine,'image_download',download), \
                 patch.object(engine,'chapter_title_from_source',lambda raw,label:label), \
                 patch.object(engine,'event',lambda *a,**kw:events.append((a,kw))), \
                 patch.object(engine,'ADAPTER',SimpleNamespace()):
                files, manifest=engine.acquire_chapter(context,chapter,Path(tmp),
                    config={'max_pages_per_chapter':100,'download_retries':1,'page_scan_steps':20,'page_scan_stability_steps':2},guard=None,visible=True)
        self.assertEqual(calls,['scan','scan'])
        self.assertEqual(downloads,[img_url],'verified image was redownloaded after tab recycling')
        self.assertEqual(len(files),1)
        self.assertEqual(manifest['total_images'],1)
        self.assertTrue(any(x[0][0]=='BROWSER_MANAGED_TAB_RECOVERED' for x in events))


class RecycledTabPartialDomRegression(unittest.TestCase):
    def test_recycled_tab_rehydrates_short_dom_without_redownloading_verified_images(self):
        """15 verified panels + recycled tab exposing 1 -> 15 must not fail."""
        chapter_url = 'https://example.test/chapter/83/'
        image_urls = {str(i): f'https://cdn.example.test/{i:04d}.jpg' for i in range(1, 16)}
        downloads = []
        snapshots = []

        def snapshot(keys):
            return ({'imgs': [{'key': key, 'url': image_urls[key], 'loaded': True,
                               'width': 1200, 'height': 1500, 'pageY': 0} for key in keys],
                     'total': len(keys), 'scrollY': 0, 'viewportHeight': 900,
                     'physicalAtBottom': False, 'missingSlots': 0},
                    list(keys),
                    {key: {'url': image_urls[key], 'width': 1200, 'height': 1500}
                     for key in keys})

        class Page:
            url = chapter_url
            def goto(self, *args, **kwargs): return None
            def content(self): return '<title>Chapter 83</title>'
            def close(self): return None

        class Checkpoint:
            def __init__(self, *args): self.recorded = {}
            def catalog_matches(self, *args): return False
            def reuse(self, *args): return None
            def record_image(self, key, position, url, path, meta):
                self.recorded[key] = (path, meta)
                return path, meta

        def fake_download(ctx, url, dest, chapter, **kwargs):
            downloads.append(url)
            position = int(Path(dest).name)
            return (Path(str(dest) + '.jpg'),
                    {'filename': f'{position:04d}.jpg', 'order': position,
                     'source_url': url, 'bytes': 12})

        def fake_scan(page, *args, **kwargs):
            progress = kwargs['on_progress']
            full = [str(i) for i in range(1, 16)]
            if not snapshots:
                info, keys, seen = snapshot(full)
                saved = progress(info, keys, seen, True)
                self.assertEqual(saved, set(full))
                snapshots.append('before-recycle')
                raise BrowserManagedTabRecycled('replacement owned tab')
            info, keys, seen = snapshot(['1'])
            self.assertEqual(progress(info, keys, seen, False), {'1'})
            snapshots.append('temporary-short-dom')
            info, keys, seen = snapshot(full)
            self.assertEqual(progress(info, keys, seen, True), set(full))
            snapshots.append('fully-rehydrated')
            return [(key, seen[key]) for key in keys]

        with tempfile.TemporaryDirectory() as temp:
            context = SimpleNamespace(new_page=lambda: Page(),
                                      request=SimpleNamespace(reuses_loaded_page_images=True))
            chapter = SimpleNamespace(chapter_id='83', url=chapter_url, label='Chapter 83')
            with patch.object(engine, 'ChapterImageCheckpoint', Checkpoint), \
                 patch.object(engine, 'scan_browser_images', fake_scan), \
                 patch.object(engine, 'image_download', fake_download), \
                 patch.object(engine, 'chapter_title_from_source', lambda raw, label: label), \
                 patch.object(engine, 'event', lambda *args, **kwargs: None), \
                 patch.object(engine, 'ADAPTER', SimpleNamespace()):
                files, manifest = engine.acquire_chapter(context, chapter, Path(temp),
                    config={'max_pages_per_chapter': 100, 'download_retries': 1,
                            'page_scan_steps': 20, 'page_scan_stability_steps': 2},
                    guard=None, visible=True)
        self.assertEqual(snapshots, ['before-recycle', 'temporary-short-dom', 'fully-rehydrated'])
        self.assertEqual(len(downloads), 15)
        self.assertEqual(len(set(downloads)), 15)
        self.assertEqual(len(files), 15)
        self.assertEqual(manifest['total_images'], 15)
        self.assertEqual([p['order'] for p in manifest['images']], list(range(1, 16)))

if __name__=='__main__': unittest.main()
