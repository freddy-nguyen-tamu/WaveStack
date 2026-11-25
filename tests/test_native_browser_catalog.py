"""Provider-neutral browser discovery dispatch + active-adapter fixture (no network)."""
import json
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from reusable import engine
from site_specific import site_adapter as a

class BrowserCatalogDispatch(unittest.TestCase):
    def test_optional_hook_uses_original_context_and_normal_visit(self):
        context=object();page=SimpleNamespace(goto=lambda *x,**k:'navigated')
        chapter=engine.Chapter('test','Chapter 1','https://example.test/chapter/1')
        def catalog(ctx,url,raw,chapter_class,visit):
            self.assertIs(ctx,context); self.assertEqual(raw,'native markup')
            self.assertIs(chapter_class,engine.Chapter); self.assertEqual(visit(page,url),'navigated')
            return [chapter]
        with patch.object(engine,'ADAPTER',SimpleNamespace(custom_browser_chapters=catalog)),patch.object(engine,'chapter_links',side_effect=AssertionError('fallback called')):
            self.assertEqual(engine.discover_from_live(context,chapter.url,'native markup'),[chapter])

    def test_empty_native_catalog_fails_closed(self):
        with patch.object(engine,'ADAPTER',SimpleNamespace(custom_browser_chapters=lambda *args:[])):
            with self.assertRaisesRegex(RuntimeError,'no chapters'):
                engine.discover_from_live(object(),'https://example.test','')

@unittest.skipUnless(a.SOURCE_NAME=='comix-orange-marmalade','active adapter is another site')
class ActiveAdapterBrowserCatalog(unittest.TestCase):
    def test_native_metadata_full_order(self):
        # Real captured starting URLs, synthetic remaining opaque IDs for the test only.
        urls=[a.DEFAULT_START_URL,a._NEXT]+[a._SITE+a._PATH+str(8000000+i)+'-chapter-'+str(i) for i in range(2,121)]
        def html(i):
            detail={'hid':'65gg','title':'Orange Marmalade'}
            initial={'queries':{'["manga","detail","65gg"]':detail}}
            sync={'manga_id':'65gg','name':'Orange Marmalade','number':i}
            if i<120: sync['next_chapter_url']=urls[i+1]
            return '<script type="application/json" id="initial-data">'+json.dumps(initial)+'</script><script type="application/json" id="syncData">'+json.dumps(sync)+'</script>'
        page=SimpleNamespace(url=urls[0],content=lambda:html(urls.index(page.url)),close=lambda:None)
        context=SimpleNamespace(new_page=lambda:page)
        visited=[]
        def visit(p,url): visited.append(url); p.url=url
        with patch.object(a,'_CAPTURED_CATALOG',()),patch.object(a,'_DISCOVERED_CATALOG',()),patch('builtins.print'):
            result=a.custom_browser_chapters(context,urls[0],html(0),engine.Chapter,visit)
        self.assertEqual(visited,urls[1:]);self.assertEqual([c.url for c in result],urls)
        self.assertEqual([c.label for c in result],['Chapter '+str(i) for i in range(121)])
